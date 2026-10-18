import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildHarness,
  closeOrm,
  createRequest,
  emailBody,
  migratedOrm,
  queryRows,
  setupTenant,
  type ApiHarness,
  type TenantSetup,
} from './support.js';

describe('notifications API against PostgreSQL', () => {
  let orm: MikroORM;
  let h: ApiHarness;
  let tenant: TenantSetup;
  let other: TenantSetup;

  beforeAll(async () => {
    orm = await migratedOrm();
    h = await buildHarness(orm);
    tenant = await setupTenant(orm);
    other = await setupTenant(orm);
  });

  afterAll(async () => {
    await h.app.close();
    await closeOrm();
  });

  const key = (t: TenantSetup, name = 'all') => {
    const value = t.keys[name];
    if (value === undefined) throw new Error(`missing key ${name}`);
    return value;
  };

  it('authenticates with stored hashes: 401 for invalid/revoked keys, 403 for scope', async () => {
    expect((await createRequest(h.app, 'ns_000000000000_' + 'a'.repeat(43), 'k')).statusCode).toBe(
      401,
    );
    expect((await createRequest(h.app, key(tenant, 'read'), 'k')).statusCode).toBe(403);

    const revoked = await setupTenant(orm);
    await queryRows(orm, `update api_keys set revoked_at = now() where tenant_id = ?`, [
      revoked.tenantId,
    ]);
    expect((await createRequest(h.app, key(revoked), 'k')).statusCode).toBe(401);

    const suspended = await setupTenant(orm);
    await queryRows(orm, `update tenants set status = 'suspended' where id = ?`, [
      suspended.tenantId,
    ]);
    expect((await createRequest(h.app, key(suspended), 'k')).statusCode).toBe(401);
  });

  it('creates notification, pending delivery and outbox event, answering 202 + Location', async () => {
    const res = await createRequest(h.app, key(tenant), 'create-1');
    expect(res.statusCode).toBe(202);
    const { id } = res.json<{ id: string }>();
    expect(res.headers.location).toBe(`/v1/notifications/${id}`);

    const rows = await queryRows(
      orm,
      `select n.tenant_id, n.request_hash, n.routing_snapshot, d.submission_status, d.max_attempts,
              (select count(*)::int from outbox_events o where o.delivery_id = d.id) as outbox
       from notifications n join deliveries d on d.notification_id = n.id where n.id = ?`,
      [id],
    );
    expect(rows[0]).toMatchObject({
      tenant_id: tenant.tenantId,
      submission_status: 'pending',
      max_attempts: 3,
      outbox: 1,
    });
    expect(rows[0]?.routing_snapshot).toMatchObject({
      providerInstanceIds: [tenant.instanceIds.smtp],
      platform: null,
      maxAttempts: 3,
    });
  });

  it('replays identical requests and rejects a different payload with 409', async () => {
    const first = await createRequest(h.app, key(tenant), 'replay-1');
    const second = await createRequest(h.app, key(tenant), 'replay-1');
    expect(second.statusCode).toBe(202);
    expect(second.json()).toEqual(first.json());
    expect(second.headers.location).toBe(first.headers.location);

    const conflict = await createRequest(
      h.app,
      key(tenant),
      'replay-1',
      emailBody({ metadata: { orderId: '2' } }),
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<{ code: string }>().code).toBe('idempotency_conflict');

    // Same key in another tenant is independent.
    expect((await createRequest(h.app, key(other), 'replay-1')).statusCode).toBe(202);
  });

  it('replays the original 202 after the routing policy was disabled (409 if the payload differs)', async () => {
    const own = await setupTenant(orm);
    const first = await createRequest(h.app, key(own), 'policy-change-1');
    expect(first.statusCode).toBe(202);

    const published = await h.repositories.adminConfig.publishRoutingPolicy('test', own.tenantId, {
      routingKey: 'transactional',
      channel: 'email',
      platform: null,
      enabled: false,
      maxAttempts: 3,
      ttlSeconds: 86_400,
      fallbackEnabled: true,
      providerNames: ['smtp'],
    });
    expect(published).toMatchObject({ changed: true, version: 2 });

    const replay = await createRequest(h.app, key(own), 'policy-change-1');
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual(first.json());
    expect(replay.headers['idempotent-replayed']).toBe('true');

    const conflict = await createRequest(
      h.app,
      key(own),
      'policy-change-1',
      emailBody({ metadata: { orderId: 'other' } }),
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json<{ code: string }>().code).toBe('idempotency_conflict');

    // A new key is routed against the disabled policy.
    const fresh = await createRequest(h.app, key(own), 'policy-change-2');
    expect(fresh.statusCode).toBe(422);
    expect(fresh.json<{ code: string }>().code).toBe('no_compatible_route');

    const rows = await queryRows(
      orm,
      `select count(*)::int as count from notifications where tenant_id = ?`,
      [own.tenantId],
    );
    expect(rows[0]?.count).toBe(1);
  });

  it('exposes the nullable platform in the detail view', async () => {
    const created = await createRequest(h.app, key(tenant), 'platform-1');
    const id = created.json<{ id: string }>().id;
    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/notifications/${id}`,
      headers: { authorization: `Bearer ${key(tenant)}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id, channel: 'email', platform: null });
  });

  it('creates a single notification for concurrent identical requests', async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => createRequest(h.app, key(tenant), 'concurrent-1')),
    );
    expect(responses.map((r) => r.statusCode)).toEqual(Array(8).fill(202));
    expect(new Set(responses.map((r) => r.json<{ id: string }>().id)).size).toBe(1);
    const rows = await queryRows(
      orm,
      `select count(*)::int as count from notifications where tenant_id = ? and idempotency_key = ?`,
      [tenant.tenantId, 'concurrent-1'],
    );
    expect(rows[0]?.count).toBe(1);
  });

  it('rejects sms with 422 and invalid bodies with 400', async () => {
    const sms = await createRequest(h.app, key(tenant), 'sms-1', {
      channel: 'sms',
      routingKey: 'transactional',
      recipient: { phoneNumber: '+393331234567' },
      content: { text: 'hi' },
    });
    expect(sms.statusCode).toBe(422);
    expect(sms.json<{ code: string }>().code).toBe('channel_not_enabled');

    const bigMetadata = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`k${i}`, 'x'.repeat(1000)]),
    );
    for (const body of [
      emailBody({ unknown: true }),
      emailBody({ content: { from: 'shop@example.test', subject: 's' } }),
      emailBody({ metadata: bigMetadata }),
    ]) {
      const res = await createRequest(h.app, key(tenant), `bad-${randomUUID()}`, body);
      expect(res.statusCode).toBe(400);
      expect(res.json<{ code: string }>().code).toBe('validation_error');
    }

    const noRoute = await createRequest(
      h.app,
      key(tenant),
      'route-1',
      emailBody({ routingKey: 'nope' }),
    );
    expect(noRoute.statusCode).toBe(422);
    const sender = await createRequest(
      h.app,
      key(tenant),
      'sender-1',
      emailBody({ content: { from: 'x@other.test', subject: 's', text: 't' } }),
    );
    expect(sender.statusCode).toBe(403);
  });

  it('isolates reads per tenant (404 cross-tenant) and paginates lists', async () => {
    const reader = await setupTenant(orm);
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await createRequest(h.app, key(reader), `list-${i}`);
      ids.push(res.json<{ id: string }>().id);
    }
    const auth = { authorization: `Bearer ${key(reader, 'read')}` };
    const one = await h.app.inject({
      method: 'GET',
      url: `/v1/notifications/${ids[0]}`,
      headers: auth,
    });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({ id: ids[0], submissionStatus: 'pending', attempts: [] });

    const cross = await h.app.inject({
      method: 'GET',
      url: `/v1/notifications/${ids[0]}`,
      headers: { authorization: `Bearer ${key(other)}` },
    });
    expect(cross.statusCode).toBe(404);

    const page1 = await h.app.inject({
      method: 'GET',
      url: '/v1/notifications?limit=2',
      headers: auth,
    });
    const body1 = page1.json<{ items: { id: string }[]; nextCursor: string }>();
    expect(body1.items).toHaveLength(2);
    expect(body1.nextCursor).not.toBeNull();
    const page2 = await h.app.inject({
      method: 'GET',
      url: `/v1/notifications?limit=2&cursor=${encodeURIComponent(body1.nextCursor)}`,
      headers: auth,
    });
    const body2 = page2.json<{ items: { id: string }[]; nextCursor: string | null }>();
    expect(body2.items).toHaveLength(1);
    expect(body2.nextCursor).toBeNull();
    expect(new Set([...body1.items, ...body2.items].map((i) => i.id))).toEqual(new Set(ids));

    const filtered = await h.app.inject({
      method: 'GET',
      url: '/v1/notifications?status=accepted',
      headers: auth,
    });
    expect(filtered.json<{ items: unknown[] }>().items).toEqual([]);

    const bad = await h.app.inject({
      method: 'GET',
      url: '/v1/notifications?cursor=abc',
      headers: auth,
    });
    expect(bad.statusCode).toBe(400);
  });

  it('returns 503 above the outbox backlog threshold', async () => {
    const limited = await buildHarness(orm, { backlogLimit: 0 });
    try {
      const res = await createRequest(limited.app, key(tenant), 'backlog-1');
      expect(res.statusCode).toBe(503);
      expect(res.json<{ code: string }>().code).toBe('dependency_unavailable');
    } finally {
      await limited.app.close();
    }
  });
});
