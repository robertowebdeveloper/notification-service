import { describe, expect, it } from 'vitest';
import { TIMING } from '../support/env.js';
import { resendBehaviours } from '../support/fake-resend.js';
import { useE2eSystem } from '../support/lifecycle.js';
import { emailRequest, uniqueRecipient } from '../support/payloads.js';
import { delay, waitFor } from '../support/wait-for.js';

/**
 * Scenario 4 — crash after the provider accepted and before the result is committed: the delivery
 * becomes `unknown`; a replay is allowed only within the provider's idempotency guarantee.
 *
 * Fault injection: the fake provider receives the whole message and holds its answer; the worker
 * is SIGKILLed while waiting, so the provider has the message but the DB only has `started`.
 */
describe('scenario 4: crash between provider acceptance and commit', () => {
  const system = useE2eSystem(6);
  const timeout = TIMING.startupMs * 3 + TIMING.recoveryMs + TIMING.settleMs * 3;

  it(
    'S4.1 SMTP (no idempotency): becomes unknown, never resent, manual retry refused',
    async () => {
      const sys = system();
      const tenant = await sys.seedTenant({
        providerInstances: [sys.fakeSmtpInstance('fake-smtp', { sendTimeoutMs: 120_000 })],
        routingPolicies: [sys.policy(['fake-smtp'])],
      });
      const { worker } = await sys.startAll();
      const recipient = uniqueRecipient('s04-smtp');
      sys.smtp.program(recipient, ['hold']);
      const id = await sys.submit(tenant, emailRequest(recipient));

      await waitFor(() => sys.smtp.potentialDeliveries(recipient) === 1, {
        timeoutMs: TIMING.deliveryMs,
        description: 'message body received by the provider',
        diagnostics: () => sys.diagnostics(),
      });
      const [started] = await sys.attempts(id);
      expect(started?.outcome).toBe('started');
      expect((await sys.delivery(id))?.submission_status).toBe('sending');
      await worker.kill();
      // The provider "accepted" the message; its answer can no longer reach the dead worker.
      sys.smtp.release(recipient);

      await sys.startWorker('worker-replacement');
      const view = await sys.waitForStatus(tenant, id, ['unknown'], TIMING.recoveryMs);
      expect(view.attempts).toHaveLength(1);
      expect(view.attempts[0]?.outcome).toBe('unknown');

      await delay(TIMING.settleMs * 2);
      expect(sys.smtp.sendAttempts(recipient)).toBe(1);
      expect((await sys.view(tenant, id)).submissionStatus).toBe('unknown');
      expect(await sys.attempts(id)).toHaveLength(1);

      // Ordinary retry never overrides an ambiguous outcome.
      const retry = await sys.api.retryNotification(tenant.apiKey, id);
      expect(retry.status).toBe(409);
      expect(retry.body.code).toBe('conflict');
      await delay(TIMING.settleMs);
      expect(sys.smtp.sendAttempts(recipient)).toBe(1);
    },
    timeout,
  );

  it(
    'S4.2 Resend (idempotent 24h): replays only with the same idempotency key',
    async () => {
      const sys = system();
      const tenant = await sys.seedTenant({
        providerInstances: [sys.fakeResendInstance('fake-resend', { requestTimeoutMs: 120_000 })],
        routingPolicies: [sys.policy(['fake-resend'])],
      });
      const { worker } = await sys.startAll();
      const recipient = uniqueRecipient('s04-resend');
      sys.resend.program(recipient, [resendBehaviours.hold, resendBehaviours.accept]);
      const id = await sys.submit(tenant, emailRequest(recipient));

      const first = await waitFor(() => sys.resend.sends(recipient)[0], {
        timeoutMs: TIMING.deliveryMs,
        description: 'request received by the fake Resend API',
        diagnostics: () => sys.diagnostics(),
      });
      await worker.kill();
      sys.resend.release(recipient);

      await sys.startWorker('worker-replacement');
      const view = await sys.waitForStatus(tenant, id, ['unknown', 'accepted'], TIMING.recoveryMs);
      await delay(TIMING.settleMs * 2);
      const settled = await sys.view(tenant, id);
      expect(['unknown', 'accepted']).toContain(settled.submissionStatus);
      if (view.submissionStatus === 'accepted') expect(settled.submissionStatus).toBe('accepted');

      // Every call for this delivery reused the first idempotency key: one logical send.
      expect(sys.resend.idempotencyKeys(recipient)).toEqual([first.idempotencyKey]);
      const attempts = await sys.attempts(id);
      for (const attempt of attempts) {
        expect(attempt.provider_idempotency_key).toBe(first.idempotencyKey);
      }
      if (settled.submissionStatus === 'accepted') {
        expect(attempts.some((a) => a.external_reference === first.emailId)).toBe(true);
      }
    },
    timeout,
  );
});
