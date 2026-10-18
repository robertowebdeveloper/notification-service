import { describe, expect, it } from 'vitest';
import { TIMING } from '../support/env.js';
import { useE2eSystem } from '../support/lifecycle.js';
import { emailRequest, uniqueRecipient } from '../support/payloads.js';
import { holdsFor, waitFor } from '../support/wait-for.js';

/**
 * Scenario 10 — per-provider limits are respected with several workers; sending is suspended
 * while the limiter is unavailable and resumes afterwards.
 */
describe('scenario 10: provider rate limits', () => {
  const system = useE2eSystem(12);

  it(
    'S10.1 a per-instance sendRateLimit holds across two workers, without extra attempts',
    async () => {
      const sys = system();
      const burst = 2;
      const perSecond = 2;
      const total = 12;
      const tenant = await sys.seedTenant({
        providerInstances: [{ ...sys.fakeSmtpInstance(), sendRateLimit: { burst, perSecond } }],
        routingPolicies: [sys.policy(['fake-smtp'])],
      });
      await sys.startAll();
      await sys.startWorker('worker-b');
      const recipients = Array.from({ length: total }, () => uniqueRecipient('s10-rate'));
      const ids = await Promise.all(recipients.map((r) => sys.submit(tenant, emailRequest(r))));

      for (const id of ids) await sys.waitForStatus(tenant, id, ['accepted'], TIMING.recoveryMs);

      // Provider-side timestamps of every send call (RCPT TO), in order.
      const times = recipients
        .flatMap((r) => sys.smtp.transactions.filter((t) => t.recipient === r))
        .map((t) => t.rcptAt.getTime())
        .sort((a, b) => a - b);
      expect(times).toHaveLength(total);
      // Token bucket bound for every window [t_i, t_j]: burst + rate x duration (+1 for the
      // latency between the limiter decision and the provider seeing the call).
      for (let i = 0; i < times.length; i += 1) {
        for (let j = i; j < times.length; j += 1) {
          const windowS = ((times[j] ?? 0) - (times[i] ?? 0)) / 1000;
          expect(j - i + 1, `window ${String(i)}..${String(j)}`).toBeLessThanOrEqual(
            burst + Math.floor(perSecond * windowS) + 1,
          );
        }
      }
      const spanMs = (times.at(-1) ?? 0) - (times[0] ?? 0);
      expect(spanMs).toBeGreaterThanOrEqual(((total - burst - 1) / perSecond) * 1000);

      // Local quota deferrals do not consume attempts.
      for (const [index, recipient] of recipients.entries()) {
        expect(sys.smtp.sendAttempts(recipient)).toBe(1);
        const delivery = await sys.delivery(ids[index] ?? 0);
        expect(delivery?.attempts_used).toBe(1);
        expect(await sys.attempts(ids[index] ?? 0)).toHaveLength(1);
      }
    },
    TIMING.startupMs * 2 + TIMING.recoveryMs + TIMING.deliveryMs,
  );

  it(
    'S10.2 sending is suspended while the limiter fails and resumes when it recovers',
    async () => {
      const sys = system();
      const tenant = await sys.seedTenant({
        providerInstances: [sys.fakeSmtpInstance()],
        routingPolicies: [sys.policy(['fake-smtp'])],
      });
      const instanceId = tenant.providerInstanceIds['fake-smtp'];
      if (instanceId === undefined) throw new Error('instance not seeded');
      const { worker } = await sys.startAll();

      // Fault injection on this file's Valkey DB only: the token bucket key of the instance gets
      // the wrong type, so every limiter call errors while the queue keeps working. (Key layout of
      // ValkeyTokenBucketRateLimiter: `ns:ratelimit:{<instanceId>}`.)
      const bucketKey = `ns:ratelimit:{${instanceId}}`;
      await sys.queue.redis.set(bucketKey, 'limiter-unavailable');

      const recipient = uniqueRecipient('s10-down');
      const id = await sys.submit(tenant, emailRequest(recipient));
      await worker.waitForLine(/sending suspended/, TIMING.deliveryMs);
      await holdsFor(
        async () => {
          const delivery = await sys.delivery(id);
          return (
            sys.smtp.sendAttempts(recipient) === 0 &&
            delivery?.attempts_used === 0 &&
            delivery.submission_status !== 'failed' &&
            (await sys.attempts(id)).length === 0
          );
        },
        {
          durationMs: TIMING.settleMs,
          description: 'no provider call and no attempt consumed while the limiter is down',
          diagnostics: async () => JSON.stringify(await sys.deliveryState(id)),
        },
      );

      await sys.queue.redis.del(bucketKey);
      const view = await sys.waitForStatus(tenant, id, ['accepted'], TIMING.recoveryMs);
      expect(view.attempts).toHaveLength(1);
      expect(sys.smtp.sendAttempts(recipient)).toBe(1);
      await waitFor(async () => (await sys.delivery(id))?.attempts_used === 1, {
        timeoutMs: 5_000,
        description: 'one attempt consumed',
      });
    },
    TIMING.startupMs * 2 + TIMING.recoveryMs + TIMING.deliveryMs + TIMING.settleMs,
  );
});
