import { describe, expect, it } from 'vitest';
import { TIMING } from '../support/env.js';
import { useE2eSystem } from '../support/lifecycle.js';
import { emailRequest, uniqueRecipient } from '../support/payloads.js';
import { delay, holdsFor, waitFor } from '../support/wait-for.js';

/**
 * Scenario 6 — two concurrent workers, lease renewal and a stale worker produce no illegal
 * updates; an expired lease does not authorise a second send by itself.
 */
describe('scenario 6: concurrent and stale workers', () => {
  const system = useE2eSystem(8);

  it(
    'S6.1 two workers share the load: every delivery is sent exactly once',
    async () => {
      const sys = system();
      const tenant = await sys.seedTenant({
        providerInstances: [sys.fakeSmtpInstance()],
        routingPolicies: [sys.policy(['fake-smtp'])],
      });
      await sys.startAll();
      await sys.startWorker('worker-b');
      const recipients = Array.from({ length: 30 }, () => uniqueRecipient('s06-load'));
      const ids = await Promise.all(recipients.map((r) => sys.submit(tenant, emailRequest(r))));

      for (const id of ids) await sys.waitForStatus(tenant, id, ['accepted'], TIMING.recoveryMs);
      await delay(TIMING.settleMs);
      for (const [index, recipient] of recipients.entries()) {
        expect(sys.smtp.sendAttempts(recipient), recipient).toBe(1);
        const attempts = await sys.attempts(ids[index] ?? 0);
        expect(attempts).toHaveLength(1);
        expect(attempts[0]?.outcome).toBe('accepted');
      }
    },
    TIMING.startupMs * 2 + TIMING.recoveryMs + TIMING.settleMs * 2,
  );

  it(
    'S6.2 a send outlasting the lease keeps it renewed: no takeover, no second send',
    async () => {
      const sys = system();
      // Short lease (minimum allowed: 3 x LIMITS_BACKEND_TIMEOUT_MS) and a send held for more
      // than twice that, well within the worker send cap.
      const leaseMs = 6_000;
      const holdMs = leaseMs * 2 + 4_000;
      const env = { DELIVERY_LEASE_MS: String(leaseMs), WORKER_SEND_TIMEOUT_MS: '60000' };
      const tenant = await sys.seedTenant({
        providerInstances: [
          sys.fakeSmtpInstance('fake-smtp', { sendTimeoutMs: 120_000, socketTimeoutMs: 120_000 }),
        ],
        routingPolicies: [sys.policy(['fake-smtp'])],
      });
      await sys.startApi();
      await sys.startDispatcher('dispatcher', env);
      await sys.startWorker('worker-a', env);
      await sys.startWorker('worker-b', env);
      const recipient = uniqueRecipient('s06-renew');
      sys.smtp.program(recipient, ['hold']);
      const id = await sys.submit(tenant, emailRequest(recipient));
      await waitFor(() => sys.smtp.potentialDeliveries(recipient) === 1, {
        timeoutMs: TIMING.deliveryMs,
        description: 'held message received',
        diagnostics: () => sys.diagnostics(),
      });

      const leaseRow = () =>
        sys.db.one<{ status: string; token: string | null; expires: Date | null }>(
          `select submission_status as status, lease_token as token, lease_expires_at as expires
           from deliveries where notification_id = ?`,
          [id],
        );
      const initial = await leaseRow();
      expect(initial?.status).toBe('sending');
      const initialExpiry = new Date(initial?.expires ?? 0).getTime();
      const expiries = new Set<number>([initialExpiry]);
      await holdsFor(
        async () => {
          const row = await leaseRow();
          if (row?.expires) expiries.add(new Date(row.expires).getTime());
          // Same owner (token), still sending, lease never lapsed, a single provider call.
          return (
            row?.status === 'sending' &&
            row.token === initial?.token &&
            row.expires !== null &&
            new Date(row.expires).getTime() > Date.now() - 500 &&
            sys.smtp.sendAttempts(recipient) === 1
          );
        },
        {
          durationMs: holdMs,
          intervalMs: 500,
          description: 'lease renewed by its owner, delivery "sending", one send',
          diagnostics: async () =>
            `sends=${String(sys.smtp.sendAttempts(recipient))} ${JSON.stringify(await leaseRow())}\n${sys.diagnostics()}`,
        },
      );
      // The expiry moved forward past the original lease at least twice.
      const advanced = [...expiries].filter((t) => t > initialExpiry);
      expect(advanced.length).toBeGreaterThanOrEqual(2);
      expect(Math.max(...expiries)).toBeGreaterThan(initialExpiry + leaseMs);

      sys.smtp.release(recipient);
      const view = await sys.waitForStatus(tenant, id, ['accepted']);
      expect(view.attempts).toHaveLength(1);
      expect(view.attempts[0]?.outcome).toBe('accepted');
      expect(sys.smtp.sendAttempts(recipient)).toBe(1);
    },
    TIMING.startupMs * 2 + TIMING.deliveryMs * 2 + 30_000,
  );

  it(
    'S6.2b a send outlasting the worker send cap becomes unknown, with no second send',
    async () => {
      const sys = system();
      const tenant = await sys.seedTenant({
        providerInstances: [
          sys.fakeSmtpInstance('fake-smtp', { sendTimeoutMs: 300_000, socketTimeoutMs: 300_000 }),
        ],
        routingPolicies: [sys.policy(['fake-smtp'])],
      });
      await sys.startAll();
      await sys.startWorker('worker-b');
      const recipient = uniqueRecipient('s06-cap');
      sys.smtp.program(recipient, ['hold']);
      const id = await sys.submit(tenant, emailRequest(recipient));
      const view = await sys.waitForStatus(
        tenant,
        id,
        ['unknown', 'accepted', 'failed'],
        TIMING.recoveryMs,
      );
      expect(view.submissionStatus).toBe('unknown');
      expect(view.attempts).toHaveLength(1);
      sys.smtp.release(recipient);
      await delay(TIMING.settleMs);
      expect(sys.smtp.sendAttempts(recipient)).toBe(1);
      expect((await sys.view(tenant, id)).submissionStatus).toBe('unknown');
    },
    TIMING.startupMs * 2 + TIMING.recoveryMs + TIMING.settleMs * 2,
  );

  it(
    'S6.3 a paused (stale) worker cannot overwrite the recovered state, and nobody resends',
    async () => {
      const sys = system();
      const tenant = await sys.seedTenant({
        providerInstances: [
          sys.fakeSmtpInstance('fake-smtp', { sendTimeoutMs: 300_000, socketTimeoutMs: 300_000 }),
        ],
        routingPolicies: [sys.policy(['fake-smtp'])],
      });
      await sys.startApi();
      await sys.startDispatcher();
      const stale = await sys.startWorker('worker-a');
      const recipient = uniqueRecipient('s06-stale');
      sys.smtp.program(recipient, ['hold']);
      const id = await sys.submit(tenant, emailRequest(recipient));
      await waitFor(() => sys.smtp.potentialDeliveries(recipient) === 1, {
        timeoutMs: TIMING.deliveryMs,
        description: 'held message received',
        diagnostics: () => sys.diagnostics(),
      });

      // Freeze worker A mid-send: it can neither renew its lease nor write results.
      stale.signal('SIGSTOP');
      await sys.startWorker('worker-b');
      const recovered = await sys.waitForStatus(tenant, id, ['unknown'], TIMING.recoveryMs);
      expect(recovered.attempts).toHaveLength(1);
      expect(sys.smtp.sendAttempts(recipient)).toBe(1);
      const fenced = await sys.delivery(id);

      // The provider answers 250 and worker A resumes with its expired lease.
      sys.smtp.release(recipient);
      stale.signal('SIGCONT');
      await delay(TIMING.settleMs * 2);

      const after = await sys.delivery(id);
      expect(after?.submission_status).toBe('unknown');
      expect(after?.version).toBe(fenced?.version);
      const attempts = await sys.attempts(id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.outcome).toBe('unknown');
      expect(sys.smtp.sendAttempts(recipient)).toBe(1);
    },
    TIMING.startupMs * 3 + TIMING.recoveryMs + TIMING.settleMs * 3,
  );
});
