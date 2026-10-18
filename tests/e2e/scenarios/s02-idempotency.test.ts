import { describe, expect, it } from 'vitest';
import { TIMING } from '../support/env.js';
import { useE2eSystem } from '../support/lifecycle.js';
import { emailRequest, uniqueIdempotencyKey, uniqueRecipient } from '../support/payloads.js';
import { delay } from '../support/wait-for.js';

/**
 * Scenario 2 — concurrent identical requests create one notification; the same Idempotency-Key
 * with a different payload answers 409.
 */
describe('scenario 2: idempotent submission', () => {
  const system = useE2eSystem(4);
  const timeout = TIMING.startupMs * 2 + TIMING.deliveryMs * 2;

  it(
    'S2.1 concurrent identical requests produce one notification and one send',
    async () => {
      const sys = system();
      const tenant = await sys.seedTenant({
        providerInstances: [sys.fakeSmtpInstance()],
        routingPolicies: [sys.policy(['fake-smtp'])],
      });
      await sys.startAll();
      const recipient = uniqueRecipient('s02');
      const body = emailRequest(recipient);
      const key = uniqueIdempotencyKey('s02');

      const responses = await Promise.all(
        Array.from({ length: 12 }, () => sys.api.createNotification(tenant.apiKey, key, body)),
      );
      for (const response of responses) {
        expect(response.status, JSON.stringify(response.body)).toBe(202);
        expect(response.body.submissionStatus).toBe('pending');
      }
      const ids = new Set(responses.map((r) => r.body.id));
      expect(ids.size).toBe(1);
      const [id] = [...ids];
      if (id === undefined) throw new Error('no id');

      expect(
        await sys.db.count(
          'select count(*) from notifications where tenant_id = ? and idempotency_key = ?',
          [tenant.tenantId, key],
        ),
      ).toBe(1);
      expect(
        await sys.db.count('select count(*) from deliveries where notification_id = ?', [id]),
      ).toBe(1);

      await sys.waitForStatus(tenant, id, ['accepted']);
      // A replay after completion still returns the original 202 response, without a new delivery.
      const replay = await sys.api.createNotification(tenant.apiKey, key, body);
      expect(replay.status).toBe(202);
      expect(replay.body).toEqual({ id, submissionStatus: 'pending' });

      await delay(TIMING.settleMs);
      expect(sys.smtp.sendAttempts(recipient)).toBe(1);
      expect(await sys.attempts(id)).toHaveLength(1);
    },
    timeout,
  );

  it(
    'S2.2 same key with a different payload answers 409 idempotency_conflict',
    async () => {
      const sys = system();
      const tenant = await sys.seedTenant({
        providerInstances: [sys.fakeSmtpInstance()],
        routingPolicies: [sys.policy(['fake-smtp'])],
      });
      await sys.startApi();
      const key = uniqueIdempotencyKey('s02-conflict');
      const first = await sys.api.createNotification(
        tenant.apiKey,
        key,
        emailRequest(uniqueRecipient('s02')),
      );
      expect(first.status).toBe(202);

      const conflict = await sys.api.createNotification(
        tenant.apiKey,
        key,
        emailRequest(uniqueRecipient('s02-other')),
      );
      expect(conflict.status).toBe(409);
      expect(conflict.body).toMatchObject({ code: 'idempotency_conflict' });
      expect(conflict.body.requestId).toEqual(expect.any(String));

      // Concurrent conflicting payloads: exactly one wins, the others get 409.
      const raceKey = uniqueIdempotencyKey('s02-race');
      const race = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          sys.api.createNotification(
            tenant.apiKey,
            raceKey,
            emailRequest(`s02-race-${String(i)}@example.test`),
          ),
        ),
      );
      expect(race.filter((r) => r.status === 202)).toHaveLength(1);
      expect(race.filter((r) => r.status === 409)).toHaveLength(5);
      expect(
        await sys.db.count(
          'select count(*) from notifications where tenant_id = ? and idempotency_key = ?',
          [tenant.tenantId, raceKey],
        ),
      ).toBe(1);
    },
    timeout,
  );

  it(
    'S2.3 the Idempotency-Key header is mandatory',
    async () => {
      const sys = system();
      const tenant = await sys.seedTenant({
        providerInstances: [sys.fakeSmtpInstance()],
        routingPolicies: [sys.policy(['fake-smtp'])],
      });
      await sys.startApi();
      const response = await sys.api.request('POST', '/v1/notifications', {
        apiKey: tenant.apiKey,
        body: emailRequest(uniqueRecipient('s02')),
      });
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: 'validation_error' });
    },
    timeout,
  );
});
