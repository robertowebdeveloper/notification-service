import { describe, expect, it } from 'vitest';
import { TIMING } from '../support/env.js';
import { resendBehaviours } from '../support/fake-resend.js';
import { useE2eSystem } from '../support/lifecycle.js';
import { emailRequest, uniqueRecipient } from '../support/payloads.js';
import type { SeededTenant } from '../support/seed.js';
import type { E2eSystem } from '../support/system.js';
import { waitFor } from '../support/wait-for.js';
import {
  generateWebhookSecret,
  signedResendWebhook,
  type ResendEventInput,
} from '../support/webhooks.js';

/**
 * Scenario 8 — duplicate, out-of-order and early (before the external reference is committed)
 * webhooks are persisted and reconciled correctly.
 */
describe('scenario 8: provider webhooks', () => {
  const system = useE2eSystem(10);
  const timeout = TIMING.startupMs * 2 + TIMING.recoveryMs + TIMING.deliveryMs;

  async function setup(sys: E2eSystem) {
    const tenant = await sys.seedTenant({
      providerInstances: [sys.fakeResendInstance()],
      routingPolicies: [sys.policy(['fake-resend'])],
    });
    const instanceId = tenant.providerInstanceIds['fake-resend'];
    if (instanceId === undefined) throw new Error('fake-resend instance not seeded');
    await sys.startAll();
    return { tenant, instanceId };
  }

  async function post(sys: E2eSystem, instanceId: string, input: ResendEventInput) {
    const webhook = signedResendWebhook(sys.webhookSecret, input);
    const response = await sys.api.postWebhook(
      'resend',
      instanceId,
      webhook.rawBody,
      webhook.headers,
    );
    return { webhook, response };
  }

  async function storedEvents(sys: E2eSystem, instanceId: string, eventId: string) {
    return sys.db.query<{
      delivery_id: string | null;
      processed_at: Date | null;
      event_type: string;
    }>(
      `select delivery_id, processed_at, event_type from provider_events
       where provider_instance_id = ? and external_event_id = ?`,
      [instanceId, eventId],
    );
  }

  async function waitProcessed(sys: E2eSystem, instanceId: string, eventId: string) {
    return waitFor(
      async () => {
        const [event] = await storedEvents(sys, instanceId, eventId);
        return event?.processed_at ? event : undefined;
      },
      {
        timeoutMs: TIMING.recoveryMs,
        description: `provider event ${eventId} processed`,
        diagnostics: () => sys.diagnostics(),
      },
    );
  }

  async function waitReceipt(sys: E2eSystem, tenant: SeededTenant, id: string, receipt: string) {
    return waitFor(
      async () => {
        const view = await sys.view(tenant, id);
        return view.receiptStatus === receipt ? view : undefined;
      },
      {
        timeoutMs: TIMING.recoveryMs,
        description: `receipt ${receipt} for ${id}`,
        diagnostics: () => sys.diagnostics(),
      },
    );
  }

  it(
    'S8.1 duplicates are acknowledged, stored once and applied once',
    async () => {
      const sys = system();
      const { tenant, instanceId } = await setup(sys);
      const recipient = uniqueRecipient('s08-dup');
      const id = await sys.submit(tenant, emailRequest(recipient));
      await sys.waitForStatus(tenant, id, ['accepted']);
      const emailId = sys.resend.sends(recipient)[0]?.emailId;
      if (emailId === undefined) throw new Error('no email id');

      const first = await post(sys, instanceId, { type: 'email.delivered', emailId });
      expect(first.response.status).toBeGreaterThanOrEqual(200);
      expect(first.response.status).toBeLessThan(300);
      const duplicate = await sys.api.postWebhook(
        'resend',
        instanceId,
        first.webhook.rawBody,
        first.webhook.headers,
      );
      expect(duplicate.status).toBeGreaterThanOrEqual(200);
      expect(duplicate.status).toBeLessThan(300);

      expect(await storedEvents(sys, instanceId, first.webhook.eventId)).toHaveLength(1);
      await waitReceipt(sys, tenant, id, 'delivered');
      const view = await sys.view(tenant, id);
      expect(view.submissionStatus).toBe('accepted');
    },
    timeout,
  );

  it(
    'S8.2 out-of-order events never degrade a confirmed receipt',
    async () => {
      const sys = system();
      const { tenant, instanceId } = await setup(sys);
      const recipient = uniqueRecipient('s08-order');
      const id = await sys.submit(tenant, emailRequest(recipient));
      await sys.waitForStatus(tenant, id, ['accepted']);
      const emailId = sys.resend.sends(recipient)[0]?.emailId;
      if (emailId === undefined) throw new Error('no email id');

      const now = Date.now();
      const delivered = await post(sys, instanceId, {
        type: 'email.delivered',
        emailId,
        createdAt: new Date(now - 1_000),
      });
      expect(delivered.response.status).toBeLessThan(300);
      await waitReceipt(sys, tenant, id, 'delivered');

      // The earlier "sent" event arrives late.
      const late = await post(sys, instanceId, {
        type: 'email.sent',
        emailId,
        createdAt: new Date(now - 10_000),
      });
      expect(late.response.status).toBeLessThan(300);
      await waitProcessed(sys, instanceId, late.webhook.eventId);
      expect((await sys.view(tenant, id)).receiptStatus).toBe('delivered');
      expect((await sys.delivery(id))?.receipt_status).toBe('delivered');
    },
    timeout,
  );

  it(
    'S8.3 a webhook arriving before the external reference is committed is reconciled later',
    async () => {
      const sys = system();
      const { tenant, instanceId } = await setup(sys);
      const recipient = uniqueRecipient('s08-early');
      sys.resend.program(recipient, [resendBehaviours.hold]);
      const id = await sys.submit(tenant, emailRequest(recipient));
      const request = await waitFor(() => sys.resend.sends(recipient)[0], {
        timeoutMs: TIMING.deliveryMs,
        description: 'send held by the fake Resend API',
        diagnostics: () => sys.diagnostics(),
      });
      const emailId = request.emailId;
      if (emailId === undefined) throw new Error('no email id');

      const early = await post(sys, instanceId, { type: 'email.delivered', emailId });
      expect(early.response.status).toBeGreaterThanOrEqual(200);
      expect(early.response.status).toBeLessThan(300);
      // Durably stored before the success answer, not yet associated with a delivery.
      const [stored] = await storedEvents(sys, instanceId, early.webhook.eventId);
      expect(stored).toBeDefined();
      expect(stored?.delivery_id).toBeNull();

      sys.resend.release(recipient);
      await sys.waitForStatus(tenant, id, ['accepted']);
      await waitReceipt(sys, tenant, id, 'delivered');
      const delivery = await sys.delivery(id);
      const [correlated] = await storedEvents(sys, instanceId, early.webhook.eventId);
      expect(correlated?.delivery_id).toBe(delivery?.id);
    },
    timeout,
  );

  it(
    'S8.4 invalid signatures and unknown instances are rejected and not stored',
    async () => {
      const sys = system();
      const { instanceId } = await setup(sys);
      const forged = signedResendWebhook(generateWebhookSecret(), {
        type: 'email.delivered',
        emailId: 're_e2e_forged',
      });
      const rejected = await sys.api.postWebhook(
        'resend',
        instanceId,
        forged.rawBody,
        forged.headers,
      );
      expect(rejected.status).toBeGreaterThanOrEqual(400);
      expect(rejected.status).toBeLessThan(500);
      expect(await storedEvents(sys, instanceId, forged.eventId)).toHaveLength(0);

      const valid = signedResendWebhook(sys.webhookSecret, {
        type: 'email.delivered',
        emailId: 're_e2e_x',
      });
      const unknown = await sys.api.postWebhook(
        'resend',
        '00000000-0000-4000-8000-000000000000',
        valid.rawBody,
        valid.headers,
      );
      expect(unknown.status).toBe(404);

      const stale = signedResendWebhook(sys.webhookSecret, {
        type: 'email.delivered',
        emailId: 're_e2e_stale',
        signedAt: new Date(Date.now() - 60 * 60_000),
      });
      const staleResponse = await sys.api.postWebhook(
        'resend',
        instanceId,
        stale.rawBody,
        stale.headers,
      );
      expect(staleResponse.status).toBeGreaterThanOrEqual(400);
      expect(staleResponse.status).toBeLessThan(500);
      expect(await storedEvents(sys, instanceId, stale.eventId)).toHaveLength(0);
    },
    timeout,
  );
});
