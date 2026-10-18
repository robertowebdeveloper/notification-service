import { describe, expect, it } from 'vitest';
import { TIMING } from '../support/env.js';
import { useE2eSystem } from '../support/lifecycle.js';
import { futureChannelRequests, uniqueIdempotencyKey } from '../support/payloads.js';

/**
 * Scenario 12 — future channels are representable in the contracts but answer 422
 * `channel_not_enabled` while not enabled.
 */
describe('scenario 12: channels not enabled', () => {
  const system = useE2eSystem(14);

  it(
    'S12.1 valid sms, push and messaging requests answer 422 channel_not_enabled',
    async () => {
      const sys = system();
      const tenant = await sys.seedTenant({
        providerInstances: [sys.fakeSmtpInstance()],
        routingPolicies: [sys.policy(['fake-smtp'])],
      });
      await sys.startApi();

      for (const [name, body] of Object.entries(futureChannelRequests)) {
        const response = await sys.api.createNotification(
          tenant.apiKey,
          uniqueIdempotencyKey(),
          body,
        );
        expect(response.status, name).toBe(422);
        expect(response.body.code, name).toBe('channel_not_enabled');
        expect(response.body.requestId, name).toEqual(expect.any(String));
      }
      expect(
        await sys.db.count('select count(*) from notifications where tenant_id = ?', [
          tenant.tenantId,
        ]),
      ).toBe(0);

      // Malformed payloads of those channels are still schema errors (400), not 422.
      const invalid = await sys.api.createNotification(tenant.apiKey, uniqueIdempotencyKey(), {
        ...futureChannelRequests.sms,
        recipient: { phoneNumber: 'not-e164' },
      });
      expect(invalid.status).toBe(400);
    },
    TIMING.startupMs * 2,
  );
});
