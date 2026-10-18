import { describe, expect, it } from 'vitest';
import type { SubmissionStatus } from '../../../src/contracts/statuses.js';
import { TIMING } from '../support/env.js';
import { resendBehaviours } from '../support/fake-resend.js';
import { useE2eSystem } from '../support/lifecycle.js';
import { emailRequest, uniqueRecipient } from '../support/payloads.js';
import type { SeededTenant } from '../support/seed.js';
import type { AttemptRow, E2eSystem } from '../support/system.js';
import { delay, waitFor } from '../support/wait-for.js';

/**
 * Scenario 5 — an ambiguous SMTP timeout never triggers fallback; a certainly retryable
 * rejection follows the attempt budget, backoff (incl. Retry-After) and routing policy.
 */
describe('scenario 5: ambiguous timeout vs certain retryable rejection', () => {
  const system = useE2eSystem(7);
  const timeout = TIMING.startupMs * 2 + TIMING.recoveryMs + TIMING.settleMs * 2;

  /** Polls the API until a terminal status, recording every status seen on the way. */
  async function followUntil(
    sys: E2eSystem,
    tenant: SeededTenant,
    id: string,
    terminal: readonly SubmissionStatus[],
  ) {
    const seen = new Set<SubmissionStatus>();
    const view = await waitFor(
      async () => {
        const current = await sys.view(tenant, id);
        seen.add(current.submissionStatus);
        return terminal.includes(current.submissionStatus) ? current : undefined;
      },
      {
        timeoutMs: TIMING.recoveryMs,
        intervalMs: 100,
        description: `notification ${id} to reach ${terminal.join('|')}`,
        diagnostics: async () =>
          `${JSON.stringify(await sys.deliveryState(id))}\n${sys.diagnostics()}`,
      },
    );
    return { view, seen };
  }

  function gaps(attempts: AttemptRow[]): number[] {
    return attempts
      .slice(1)
      .map(
        (a, i) =>
          new Date(a.started_at).getTime() - new Date(attempts[i]?.started_at ?? 0).getTime(),
      );
  }

  it(
    'S5.1 SMTP timeout after DATA is unknown and does not fall back to the next provider',
    async () => {
      const sys = system();
      const tenant = await sys.seedTenant({
        providerInstances: [
          sys.fakeSmtpInstance('fake-smtp', { sendTimeoutMs: 2_000, socketTimeoutMs: 2_000 }),
          sys.fakeResendInstance(),
        ],
        routingPolicies: [sys.policy(['fake-smtp', 'fake-resend'], { fallbackEnabled: true })],
      });
      await sys.startAll();
      const recipient = uniqueRecipient('s05-timeout');
      sys.smtp.program(recipient, ['hang']);
      const id = await sys.submit(tenant, emailRequest(recipient));

      const { view } = await followUntil(sys, tenant, id, ['unknown', 'accepted', 'failed']);
      expect(view.submissionStatus).toBe('unknown');
      expect(view.attempts).toHaveLength(1);
      expect(view.attempts[0]?.outcome).toBe('unknown');

      await delay(TIMING.settleMs * 2);
      expect(sys.resend.sends(recipient)).toHaveLength(0);
      expect(sys.smtp.sendAttempts(recipient)).toBe(1);
      expect((await sys.view(tenant, id)).submissionStatus).toBe('unknown');
    },
    timeout,
  );

  it(
    'S5.2 certain 4xx rejection retries with backoff until the budget is exhausted',
    async () => {
      const sys = system();
      const tenant = await sys.seedTenant({
        providerInstances: [sys.fakeSmtpInstance()],
        routingPolicies: [sys.policy(['fake-smtp'], { maxAttempts: 3, fallbackEnabled: false })],
      });
      await sys.startAll();
      const recipient = uniqueRecipient('s05-451');
      sys.smtp.program(recipient, ['rcpt-451']);
      const id = await sys.submit(tenant, emailRequest(recipient));

      const { view, seen } = await followUntil(sys, tenant, id, ['failed', 'accepted', 'unknown']);
      expect(view.submissionStatus).toBe('failed');
      expect(seen.has('retry_wait')).toBe(true);
      expect(view.attempts).toHaveLength(3);
      expect(view.attempts.every((a) => a.outcome === 'rejected')).toBe(true);
      expect(view.lastError).not.toBeNull();

      const attempts = await sys.attempts(id);
      expect(attempts.map((a) => a.error_kind)).toEqual(['retryable', 'retryable', 'retryable']);
      for (const gap of gaps(attempts)) expect(gap).toBeGreaterThanOrEqual(TIMING.minBackoffMs);
      await delay(TIMING.settleMs);
      expect(sys.smtp.sendAttempts(recipient)).toBe(3);
    },
    timeout,
  );

  it(
    'S5.3 a temporary rejection followed by success ends accepted with one message',
    async () => {
      const sys = system();
      const tenant = await sys.seedTenant({
        providerInstances: [sys.fakeSmtpInstance()],
        routingPolicies: [sys.policy(['fake-smtp'], { maxAttempts: 3, fallbackEnabled: false })],
      });
      await sys.startAll();
      const recipient = uniqueRecipient('s05-recover');
      sys.smtp.program(recipient, ['data-451', 'accept']);
      const id = await sys.submit(tenant, emailRequest(recipient));

      const { view } = await followUntil(sys, tenant, id, ['accepted', 'failed', 'unknown']);
      expect(view.submissionStatus).toBe('accepted');
      expect(view.attempts.map((a) => a.outcome)).toEqual(['rejected', 'accepted']);
      expect(sys.smtp.acceptedMessages(recipient)).toHaveLength(1);
    },
    timeout,
  );

  it(
    'S5.4 a permanent rejection fails at once without retry',
    async () => {
      const sys = system();
      const tenant = await sys.seedTenant({
        providerInstances: [sys.fakeSmtpInstance()],
        routingPolicies: [sys.policy(['fake-smtp'], { maxAttempts: 5 })],
      });
      await sys.startAll();
      const recipient = uniqueRecipient('s05-550');
      sys.smtp.program(recipient, ['rcpt-550']);
      const id = await sys.submit(tenant, emailRequest(recipient));

      const { view } = await followUntil(sys, tenant, id, ['failed', 'accepted', 'unknown']);
      expect(view.submissionStatus).toBe('failed');
      expect(view.attempts).toHaveLength(1);
      await delay(TIMING.settleMs);
      expect(sys.smtp.sendAttempts(recipient)).toBe(1);
    },
    timeout,
  );

  it(
    'S5.5 Retry-After from the provider is respected before the next attempt',
    async () => {
      const sys = system();
      const tenant = await sys.seedTenant({
        providerInstances: [sys.fakeResendInstance()],
        routingPolicies: [sys.policy(['fake-resend'], { maxAttempts: 3, fallbackEnabled: false })],
      });
      await sys.startAll();
      const recipient = uniqueRecipient('s05-429');
      sys.resend.program(recipient, [resendBehaviours.rateLimited(7), resendBehaviours.accept]);
      const id = await sys.submit(tenant, emailRequest(recipient));

      const { view } = await followUntil(sys, tenant, id, ['accepted', 'failed', 'unknown']);
      expect(view.submissionStatus).toBe('accepted');
      const sends = sys.resend.sends(recipient);
      expect(sends).toHaveLength(2);
      const gap = (sends[1]?.receivedAt.getTime() ?? 0) - (sends[0]?.receivedAt.getTime() ?? 0);
      expect(gap).toBeGreaterThanOrEqual(7_000 - 250);
      // Both calls belong to distinct attempts of the same delivery after a certain rejection.
      expect(view.attempts.map((a) => a.outcome)).toEqual(['rejected', 'accepted']);
    },
    timeout,
  );

  it(
    'S5.6 the attempt budget is global to the delivery, not multiplied per provider',
    async () => {
      const sys = system();
      const tenant = await sys.seedTenant({
        providerInstances: [sys.fakeSmtpInstance(), sys.fakeResendInstance()],
        routingPolicies: [
          sys.policy(['fake-smtp', 'fake-resend'], { maxAttempts: 3, fallbackEnabled: true }),
        ],
      });
      await sys.startAll();
      const recipient = uniqueRecipient('s05-budget');
      sys.smtp.program(recipient, ['rcpt-451']);
      sys.resend.program(recipient, [resendBehaviours.rateLimited(1)]);
      const id = await sys.submit(tenant, emailRequest(recipient));

      const { view } = await followUntil(sys, tenant, id, ['failed', 'accepted', 'unknown']);
      expect(view.submissionStatus).toBe('failed');
      await delay(TIMING.settleMs);
      // Both providers reject with certainty (SMTP 451, Resend 429): fallback is allowed, but the
      // whole delivery gets 3 provider calls in total.
      const totalCalls = sys.smtp.sendAttempts(recipient) + sys.resend.sends(recipient).length;
      expect(totalCalls).toBe(3);
      expect(view.attempts).toHaveLength(3);
    },
    timeout,
  );
});
