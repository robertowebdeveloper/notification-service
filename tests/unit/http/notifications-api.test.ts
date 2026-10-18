import { beforeEach, describe, expect, it } from 'vitest';
import { buildTestApi, emailBody, instance, nextId, type TestApi } from './support/fakes.js';

const ALL_SCOPES = ['notifications:write', 'notifications:read', 'notifications:retry'] as const;

describe('public notifications API', () => {
  let api: TestApi;
  let tenantId: number;
  let key: string;

  beforeEach(async () => {
    api = await buildTestApi();
    tenantId = nextId();
    key = api.apiKeys.add(tenantId, [...ALL_SCOPES]);
    api.providerConfig.addPolicy(tenantId, [instance(tenantId)]);
  });

  function post(body: unknown, headers: Record<string, string> = {}, bearer = key) {
    return api.app.inject({
      method: 'POST',
      url: '/v1/notifications',
      headers: { authorization: `Bearer ${bearer}`, 'idempotency-key': 'k-1', ...headers },
      payload: body as Record<string, unknown>,
    });
  }

  describe('authentication', () => {
    it('rejects a missing bearer token with 401 and the uniform error body', async () => {
      const res = await api.app.inject({ method: 'GET', url: '/v1/notifications' });
      expect(res.statusCode).toBe(401);
      expect(res.headers['www-authenticate']).toBe('Bearer');
      const body = res.json<{ code: string; requestId: string }>();
      expect(body.code).toBe('unauthorized');
      expect(body.requestId).not.toBe('');
    });

    it('rejects a malformed or unknown key', async () => {
      for (const bearer of ['nope', `ns_0123456789ab_${'x'.repeat(43)}`]) {
        const res = await post(emailBody(), {}, bearer);
        expect(res.statusCode).toBe(401);
      }
    });

    it('rejects a key whose secret part does not match the stored hash', async () => {
      const tampered = key.slice(0, -1) + (key.endsWith('A') ? 'B' : 'A');
      expect((await post(emailBody(), {}, tampered)).statusCode).toBe(401);
    });

    it('rejects revoked, expired keys and inactive tenants', async () => {
      const past = new Date(Date.now() - 1000);
      const revoked = api.apiKeys.add(tenantId, [...ALL_SCOPES], { revokedAt: past });
      const expired = api.apiKeys.add(tenantId, [...ALL_SCOPES], { expiresAt: past });
      const inactive = api.apiKeys.add(tenantId, [...ALL_SCOPES], { tenantActive: false });
      for (const bearer of [revoked, expired, inactive]) {
        expect((await post(emailBody(), {}, bearer)).statusCode).toBe(401);
      }
    });

    it('returns 403 when the key lacks the route scope', async () => {
      const readOnly = api.apiKeys.add(tenantId, ['notifications:read']);
      const res = await post(emailBody(), {}, readOnly);
      expect(res.statusCode).toBe(403);
      expect(res.json<{ code: string }>().code).toBe('forbidden');
    });
  });

  describe('POST /v1/notifications', () => {
    it('accepts with 202, Location and the pending body', async () => {
      const res = await post(emailBody());
      expect(res.statusCode).toBe(202);
      const body = res.json<{ id: number; submissionStatus: string }>();
      expect(body.submissionStatus).toBe('pending');
      expect(res.headers.location).toBe(`/v1/notifications/${body.id}`);

      const stored = api.notifications.byId.get(body.id);
      expect(stored?.input.tenantId).toBe(tenantId);
      expect(stored?.input.routing.maxAttempts).toBe(4);
      expect(stored?.input.payload).toEqual({
        channel: 'email',
        recipient: { email: 'customer@example.org' },
        content: { from: 'Orders <orders@example.test>', subject: 'Order 123', text: 'Received' },
      });
      expect(api.rateLimiter.keys).toEqual([`ingress:${tenantId}`]);
    });

    it('replays the same response for the same key and payload', async () => {
      const first = await post(emailBody());
      const second = await post(emailBody());
      expect(second.statusCode).toBe(202);
      expect(second.json()).toEqual(first.json());
      expect(second.headers.location).toBe(first.headers.location);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(api.notifications.byId.size).toBe(1);
    });

    it('hashes the canonical payload independently of key order', async () => {
      await post(emailBody());
      const reordered = {
        metadata: { orderId: '123' },
        content: { text: 'Received', subject: 'Order 123', from: 'Orders <orders@example.test>' },
        recipient: { email: 'customer@example.org' },
        routingKey: 'transactional',
        channel: 'email',
      };
      expect((await post(reordered)).statusCode).toBe(202);
      expect(api.notifications.byId.size).toBe(1);
    });

    it('returns 409 idempotency_conflict for the same key with a different payload', async () => {
      await post(emailBody());
      const res = await post(emailBody({ metadata: { orderId: '999' } }));
      expect(res.statusCode).toBe(409);
      expect(res.json<{ code: string }>().code).toBe('idempotency_conflict');
    });

    it('replays the original 202 even after the policy was disabled or removed', async () => {
      const first = await post(emailBody());
      expect(first.statusCode).toBe(202);
      const policy = api.providerConfig.policies.get(`${tenantId}|transactional|email`);
      if (policy === undefined) throw new Error('policy missing');
      policy.enabled = false;
      api.notifications.pendingOutbox = 1_000;
      const createCalls = api.notifications.createCalls;

      const replay = await post(emailBody());
      expect(replay.statusCode).toBe(202);
      expect(replay.json()).toEqual(first.json());
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(api.notifications.createCalls).toBe(createCalls);

      api.providerConfig.policies.clear();
      expect((await post(emailBody())).statusCode).toBe(202);
      const conflict = await post(emailBody({ metadata: { orderId: '999' } }));
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json<{ code: string }>().code).toBe('idempotency_conflict');
      // A new key still goes through routing.
      const fresh = await post(emailBody(), { 'idempotency-key': 'k-2' });
      expect(fresh.statusCode).toBe(503);
    });

    it('returns 413 payload_too_large above the body limit', async () => {
      const res = await post(
        emailBody({
          content: {
            from: 'Orders <orders@example.test>',
            subject: 'Big',
            text: 'x'.repeat(300 * 1024),
          },
        }),
      );
      expect(res.statusCode).toBe(413);
      const body = res.json<{ code: string; requestId: string }>();
      expect(body.code).toBe('payload_too_large');
      expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('requires the Idempotency-Key header', async () => {
      const res = await api.app.inject({
        method: 'POST',
        url: '/v1/notifications',
        headers: { authorization: `Bearer ${key}` },
        payload: emailBody(),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ code: string }>().code).toBe('validation_error');
    });

    it.each([
      ['unknown top-level field', emailBody({ attachments: [] })],
      [
        'unknown content field',
        emailBody({ content: { from: 'a@example.test', subject: 's', text: 't', headers: {} } }),
      ],
      ['invalid recipient', emailBody({ recipient: { email: 'not-an-email' } })],
      ['missing subject', emailBody({ content: { from: 'a@example.test', text: 't' } })],
    ])('rejects %s with 400', async (_name, body) => {
      const res = await post(body);
      expect(res.statusCode).toBe(400);
      expect(res.json<{ code: string }>().code).toBe('validation_error');
    });

    it('requires text or html', async () => {
      const res = await post(emailBody({ content: { from: 'a@example.test', subject: 's' } }));
      expect(res.statusCode).toBe(400);
      expect(res.json<{ message: string }>().message).toMatch(/text or content.html/);
    });

    it('rejects metadata larger than 4 KiB once serialized', async () => {
      const metadata = Object.fromEntries(
        Array.from({ length: 8 }, (_, i) => [`k${i}`, 'x'.repeat(1000)]),
      );
      const res = await post(emailBody({ metadata }));
      expect(res.statusCode).toBe(400);
    });

    it('returns 422 channel_not_enabled for sms', async () => {
      const res = await post({
        channel: 'sms',
        routingKey: 'transactional',
        recipient: { phoneNumber: '+393331234567' },
        content: { text: 'hi' },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json<{ code: string }>().code).toBe('channel_not_enabled');
    });

    it('returns 422 no_compatible_route without policy or enabled instances', async () => {
      const unknownRoute = await post(emailBody({ routingKey: 'marketing' }));
      expect(unknownRoute.statusCode).toBe(422);
      expect(unknownRoute.json<{ code: string }>().code).toBe('no_compatible_route');

      const otherTenant = nextId();
      const otherKey = api.apiKeys.add(otherTenant, ['notifications:write']);
      api.providerConfig.addPolicy(otherTenant, [instance(otherTenant, { enabled: false })]);
      const disabled = await post(emailBody(), {}, otherKey);
      expect(disabled.statusCode).toBe(422);
    });

    it('snapshots only compatible enabled providers, honoring fallbackEnabled', async () => {
      const t = nextId();
      const k = api.apiKeys.add(t, ['notifications:write']);
      const a = instance(t, { name: 'a', enabled: false });
      const b = instance(t, { name: 'b' });
      const c = instance(t, { name: 'c', providerType: 'resend', config: {} });
      api.providerConfig.addPolicy(t, [a, b, c]);
      const res = await post(emailBody(), {}, k);
      const id = res.json<{ id: number }>().id;
      expect(api.notifications.byId.get(id)?.input.routing.providerInstanceIds).toEqual([
        b.id,
        c.id,
      ]);

      const t2 = nextId();
      const k2 = api.apiKeys.add(t2, ['notifications:write']);
      const d = instance(t2);
      api.providerConfig.addPolicy(t2, [d, instance(t2)], { fallbackEnabled: false });
      const res2 = await post(emailBody(), {}, k2);
      const id2 = res2.json<{ id: number }>().id;
      expect(api.notifications.byId.get(id2)?.input.routing.providerInstanceIds).toEqual([d.id]);
    });

    it('returns 403 for a sender not allowed for the tenant', async () => {
      const res = await post(
        emailBody({ content: { from: 'evil@attacker.test', subject: 's', text: 't' } }),
      );
      expect(res.statusCode).toBe(403);
      expect(res.json<{ code: string }>().code).toBe('forbidden');
    });

    it('returns 429 with Retry-After when the tenant is rate limited', async () => {
      api.rateLimiter.decision = { allowed: false, retryAfterMs: 1500 };
      const res = await post(emailBody());
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toBe('2');
      expect(res.json<{ code: string }>().code).toBe('rate_limited');
    });

    it('keeps accepting when the rate limiter is unavailable', async () => {
      api.rateLimiter.fail = true;
      expect((await post(emailBody())).statusCode).toBe(202);
    });

    it('returns 503 when the outbox backlog is above the threshold', async () => {
      api.notifications.pendingOutbox = 101;
      const res = await post(emailBody());
      expect(res.statusCode).toBe(503);
      expect(res.json<{ code: string }>().code).toBe('dependency_unavailable');
      api.notifications.pendingOutbox = 100;
      expect((await post(emailBody())).statusCode).toBe(202);
    });
  });

  describe('GET /v1/notifications', () => {
    it('returns the view of a visible notification and 404 across tenants', async () => {
      const created = (await post(emailBody())).json<{ id: number }>();
      const res = await api.app.inject({
        method: 'GET',
        url: `/v1/notifications/${created.id}`,
        headers: { authorization: `Bearer ${key}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        id: created.id,
        channel: 'email',
        platform: null,
        submissionStatus: 'pending',
        receiptStatus: 'unavailable',
        attempts: [],
        lastError: null,
      });

      const other = api.apiKeys.add(nextId(), ['notifications:read']);
      const denied = await api.app.inject({
        method: 'GET',
        url: `/v1/notifications/${created.id}`,
        headers: { authorization: `Bearer ${other}` },
      });
      expect(denied.statusCode).toBe(404);
      expect(denied.json<{ code: string }>().code).toBe('not_found');
    });

    it('rejects a non-uuid id with 400', async () => {
      const res = await api.app.inject({
        method: 'GET',
        url: '/v1/notifications/not-a-uuid',
        headers: { authorization: `Bearer ${key}` },
      });
      expect(res.statusCode).toBe(400);
    });

    it('lists tenant notifications and maps invalid cursors to 400', async () => {
      await post(emailBody());
      const list = await api.app.inject({
        method: 'GET',
        url: '/v1/notifications?limit=10&channel=email',
        headers: { authorization: `Bearer ${key}` },
      });
      expect(list.statusCode).toBe(200);
      expect(list.json<{ items: unknown[]; nextCursor: null }>().items).toHaveLength(1);

      const bad = await api.app.inject({
        method: 'GET',
        url: '/v1/notifications?cursor=garbage',
        headers: { authorization: `Bearer ${key}` },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json<{ message: string }>().message).toMatch(/cursor/);

      const unknownFilter = await api.app.inject({
        method: 'GET',
        url: '/v1/notifications?tenantId=x',
        headers: { authorization: `Bearer ${key}` },
      });
      expect(unknownFilter.statusCode).toBe(400);
    });
  });

  describe('POST /v1/notifications/:id/retry', () => {
    async function retry(id: number, headers: Record<string, string> = {}) {
      return api.app.inject({
        method: 'POST',
        url: `/v1/notifications/${id}/retry`,
        headers: { authorization: `Bearer ${key}`, 'idempotency-key': 'retry-1', ...headers },
      });
    }

    it('schedules a retry with the policy budget and the actor key', async () => {
      const created = (await post(emailBody())).json<{ id: number }>();
      const res = await retry(created.id);
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ id: created.id, submissionStatus: 'retry_wait', generation: 2 });
      expect(api.manualRetries.calls[0]).toMatchObject({
        tenantId,
        notificationId: created.id,
        retryIdempotencyKey: 'retry-1',
        maxAttempts: 4,
      });
      expect(api.providerConfig.resolveCalls.at(-1)).toEqual({
        routingKey: 'transactional',
        channel: 'email',
        platform: null,
      });
    });

    it('maps not_retryable to 409 conflict and requires its own idempotency key', async () => {
      const created = (await post(emailBody())).json<{ id: number }>();
      api.manualRetries.next = { kind: 'not_retryable', submissionStatus: 'accepted' };
      const res = await retry(created.id);
      expect(res.statusCode).toBe(409);
      expect(res.json<{ code: string }>().code).toBe('conflict');

      const noKey = await api.app.inject({
        method: 'POST',
        url: `/v1/notifications/${created.id}/retry`,
        headers: { authorization: `Bearer ${key}` },
      });
      expect(noKey.statusCode).toBe(400);
    });

    it('returns 404 for notifications of another tenant without calling the repository', async () => {
      const created = (await post(emailBody())).json<{ id: number }>();
      const other = api.apiKeys.add(nextId(), ['notifications:retry']);
      const res = await retry(created.id, { authorization: `Bearer ${other}` });
      expect(res.statusCode).toBe(404);
      expect(api.manualRetries.calls).toHaveLength(0);
    });

    it('requires the retry scope', async () => {
      const writer = api.apiKeys.add(tenantId, ['notifications:write']);
      const res = await retry(nextId(), { authorization: `Bearer ${writer}` });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('OpenAPI', () => {
    it('documents /v1 paths with bearer security and limits', async () => {
      const res = await api.app.inject({ method: 'GET', url: '/v1/openapi.json' });
      expect(res.statusCode).toBe(200);
      const doc = res.json<{
        paths: Record<string, Record<string, { security?: unknown }>>;
        components: { securitySchemes: Record<string, unknown> };
        info: { description: string };
      }>();
      expect(Object.keys(doc.paths)).toEqual(
        expect.arrayContaining([
          '/v1/notifications',
          '/v1/notifications/{id}',
          '/v1/notifications/{id}/retry',
          '/v1/webhooks/{providerType}/{instanceId}',
        ]),
      );
      expect(doc.paths['/v1/notifications']?.post?.security).toEqual([{ bearerAuth: [] }]);
      expect(doc.components.securitySchemes.bearerAuth).toEqual({ type: 'http', scheme: 'bearer' });
      expect(doc.info.description).toContain('262144');
      expect(Object.keys(doc.paths).some((p) => p.startsWith('/health'))).toBe(false);
    });

    it('documents 413 payload_too_large and the nullable platform of the detail view', async () => {
      const doc = (await api.app.inject({ method: 'GET', url: '/v1/openapi.json' })).json<{
        paths: Record<
          string,
          Record<string, { responses: Record<string, { content?: Record<string, unknown> }> }>
        >;
      }>();
      const post = doc.paths['/v1/notifications']?.post;
      expect(Object.keys(post?.responses ?? {})).toContain('413');
      expect(JSON.stringify(post?.responses['413'])).toContain('payload_too_large');
      const detail = JSON.stringify(doc.paths['/v1/notifications/{id}']?.get?.responses['200']);
      expect(detail).toContain('"platform"');
      const retry = doc.paths['/v1/notifications/{id}/retry']?.post;
      expect(JSON.stringify(retry?.responses['202'])).toContain('retry_wait');
    });
  });
});
