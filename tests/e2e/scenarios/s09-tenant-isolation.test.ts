import { describe, expect, it } from 'vitest';
import { TIMING } from '../support/env.js';
import { listItems } from '../support/api-client.js';
import { useE2eSystem } from '../support/lifecycle.js';
import { emailRequest, uniqueIdempotencyKey, uniqueRecipient } from '../support/payloads.js';
import type { E2eSystem } from '../support/system.js';

/**
 * Scenario 9 — cross-tenant access is denied, including retry, routing policies, provider
 * instances and attempt history; plus authentication and scopes.
 */
describe('scenario 9: tenant isolation and authorization', () => {
  const system = useE2eSystem(11);
  const timeout = TIMING.startupMs * 3 + TIMING.recoveryMs;

  async function twoTenants(sys: E2eSystem) {
    const tenantA = await sys.seedTenant({
      apiKeys: [
        {
          name: 'a-full',
          scopes: ['notifications:write', 'notifications:read', 'notifications:retry'],
        },
        { name: 'a-read', scopes: ['notifications:read'] },
      ],
      providerInstances: [sys.fakeSmtpInstance('smtp-a')],
      routingPolicies: [sys.policy(['smtp-a'], { maxAttempts: 1, fallbackEnabled: false })],
    });
    const tenantB = await sys.seedTenant({
      providerInstances: [sys.fakeSmtpInstance('smtp-b')],
      routingPolicies: [sys.policy(['smtp-b']), sys.policy(['smtp-b'], { routingKey: 'b-only' })],
    });
    return { tenantA, tenantB };
  }

  it(
    "S9.1 GET, list and retry of another tenant's notification answer 404",
    async () => {
      const sys = system();
      const { tenantA, tenantB } = await twoTenants(sys);
      await sys.startAll();
      // A permanent failure makes the notification eligible for a manual retry by its owner.
      const recipient = uniqueRecipient('s09-a');
      sys.smtp.program(recipient, ['rcpt-550']);
      const id = await sys.submit(tenantA, emailRequest(recipient));
      const failed = await sys.waitForStatus(tenantA, id, ['failed'], TIMING.recoveryMs);
      expect(failed.attempts).toHaveLength(1);

      const get = await sys.api.getNotification(tenantB.apiKey, id);
      expect(get.status).toBe(404);
      expect(get.body).toMatchObject({ code: 'not_found' });
      expect(JSON.stringify(get.body)).not.toContain(recipient);

      const listB = await sys.api.listNotifications(tenantB.apiKey);
      expect(listB.status).toBe(200);
      const itemsB = listItems(listB.body);
      expect(itemsB, JSON.stringify(listB.body)).toBeDefined();
      expect(itemsB?.map((n) => n.id)).not.toContain(id);

      const listA = await sys.api.listNotifications(tenantA.apiKey);
      expect(listItems(listA.body)?.map((n) => n.id)).toContain(id);

      const retry = await sys.api.retryNotification(tenantB.apiKey, id);
      expect(retry.status).toBe(404);
      expect(retry.body.code).toBe('not_found');
      expect(sys.smtp.sendAttempts(recipient)).toBe(1);
      expect(await sys.attempts(id)).toHaveLength(1);
    },
    timeout,
  );

  it(
    "S9.2 a tenant cannot use another tenant's routing policy or provider instance",
    async () => {
      const sys = system();
      const { tenantA } = await twoTenants(sys);
      await sys.startApi();
      const response = await sys.api.createNotification(
        tenantA.apiKey,
        uniqueIdempotencyKey(),
        emailRequest(uniqueRecipient('s09'), { routingKey: 'b-only' }),
      );
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('no_compatible_route');
      expect(
        await sys.db.count('select count(*) from notifications where tenant_id = ?', [
          tenantA.tenantId,
        ]),
      ).toBe(0);
    },
    timeout,
  );

  it(
    'S9.3 missing/invalid keys are 401; missing scopes are 403',
    async () => {
      const sys = system();
      const { tenantA } = await twoTenants(sys);
      await sys.startApi();
      const body = emailRequest(uniqueRecipient('s09'));

      const anonymous = await sys.api.request('POST', '/v1/notifications', {
        idempotencyKey: uniqueIdempotencyKey(),
        body,
      });
      expect(anonymous.status).toBe(401);
      expect(anonymous.body).toMatchObject({ code: 'unauthorized' });

      const forged = await sys.api.createNotification(
        `${tenantA.apiKey.slice(0, -4)}XXXX`,
        uniqueIdempotencyKey(),
        body,
      );
      expect(forged.status).toBe(401);

      const readOnly = tenantA.apiKeys['a-read'];
      if (readOnly === undefined) throw new Error('read-only key missing');
      const write = await sys.api.createNotification(readOnly, uniqueIdempotencyKey(), body);
      expect(write.status).toBe(403);
      expect(write.body.code).toBe('forbidden');
      const list = await sys.api.listNotifications(readOnly);
      expect(list.status).toBe(200);
    },
    timeout,
  );
});
