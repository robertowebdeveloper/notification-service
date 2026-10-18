import { describe, expect, it } from 'vitest';
import { TIMING } from '../support/env.js';
import { useE2eSystem } from '../support/lifecycle.js';
import { emailRequest, uniqueIdempotencyKey, uniqueRecipient } from '../support/payloads.js';
import { RESEND_TEST_API_KEY } from '../support/system.js';
import { waitFor } from '../support/wait-for.js';

/**
 * Scenario 1 — email through both adapter implementations with test transports; SMTP never
 * invents a delivery receipt.
 */
describe('scenario 1: email via SMTP (Mailpit) and Resend (fake API)', () => {
  const system = useE2eSystem(3);
  const timeout = TIMING.startupMs * 2 + TIMING.deliveryMs * 2;

  it(
    'S1.1 delivers through SMTP to Mailpit; accepted with receipt "unavailable"',
    async () => {
      const sys = system();
      const tenant = await sys.seedTenant({
        providerInstances: [sys.mailpitInstance()],
        routingPolicies: [sys.policy(['mailpit'])],
      });
      await sys.startAll();
      const recipient = uniqueRecipient('s01-smtp');
      const body = emailRequest(recipient, { subject: `S1 SMTP ${recipient}` });

      const response = await sys.api.createNotification(
        tenant.apiKey,
        uniqueIdempotencyKey(),
        body,
      );
      expect(response.status).toBe(202);
      expect(Object.keys(response.body).sort()).toEqual(['id', 'submissionStatus']);
      expect(response.body.submissionStatus).toBe('pending');
      expect(Number.isSafeInteger(response.body.id) && response.body.id > 0).toBe(true);
      expect(response.headers.get('location')).toContain(`/v1/notifications/${response.body.id}`);

      const view = await sys.waitForStatus(tenant, response.body.id, ['accepted']);
      expect(view.receiptStatus).toBe('unavailable');
      expect(view.channel).toBe('email');
      expect(view.routingKey).toBe('transactional');
      expect(view.attempts).toHaveLength(1);
      expect(view.attempts[0]).toMatchObject({ number: 1, outcome: 'accepted', errorCode: null });
      expect(view.lastError).toBeNull();

      const messages = await waitFor(
        async () => {
          const found = await sys.mailpit.byRecipient(recipient);
          return found.length > 0 ? found : undefined;
        },
        { timeoutMs: TIMING.deliveryMs, description: `Mailpit message for ${recipient}` },
      );
      expect(messages).toHaveLength(1);
      expect(messages[0]?.Subject).toBe(body.content.subject);
      const message = await sys.mailpit.message(messages[0]?.ID ?? '');
      expect(message.Text).toContain(body.content.text);
      expect(message.MessageID).not.toBe('');

      // SMTP gives no delivery receipt: it must stay "unavailable", never "delivered".
      const delivery = await sys.delivery(response.body.id);
      expect(delivery?.receipt_status).toBe('unavailable');
      await sys.mailpit.deleteByRecipient(recipient);
    },
    timeout,
  );

  it(
    'S1.2 delivers through the Resend adapter with an idempotency key',
    async () => {
      const sys = system();
      const tenant = await sys.seedTenant({
        providerInstances: [sys.fakeResendInstance()],
        routingPolicies: [sys.policy(['fake-resend'])],
      });
      await sys.startAll();
      const recipient = uniqueRecipient('s01-resend');
      const body = emailRequest(recipient);

      const id = await sys.submit(tenant, body);
      const view = await sys.waitForStatus(tenant, id, ['accepted']);
      expect(view.attempts).toHaveLength(1);
      expect(view.attempts[0]?.outcome).toBe('accepted');
      // Resend supports receipts: the receipt may be pending, but never invented as delivered.
      expect(['unavailable', 'pending']).toContain(view.receiptStatus);

      const sends = sys.resend.sends(recipient);
      expect(sends).toHaveLength(1);
      const request = sends[0];
      expect(request?.headers.authorization).toBe(`Bearer ${RESEND_TEST_API_KEY}`);
      expect(request?.idempotencyKey).toEqual(expect.any(String));
      expect(request?.body).toMatchObject({ subject: body.content.subject, to: [recipient] });

      const attempts = await sys.attempts(id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.external_reference).toBe(request?.emailId);
      expect(attempts[0]?.provider_idempotency_key).toBe(request?.idempotencyKey);
    },
    timeout,
  );
});
