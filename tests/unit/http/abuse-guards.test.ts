import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import type { FastifyInstance } from 'fastify';
import { beforeEach, describe, expect, it } from 'vitest';
import { BacklogGuard } from '../../../src/application/notifications/ingress-guards.js';
import type {
  RateLimitDecision,
  RateLimiter,
} from '../../../src/application/notifications/ports.js';
import type { ApiKeyRecord } from '../../../src/application/ports/lookup-repositories.js';
import { createApiDependencies } from '../../../src/http/api-dependencies.js';
import { buildApp, type HttpServerOptions } from '../../../src/http/app.js';
import { signSvixPayload } from '../../../src/infrastructure/providers/email/resend-webhook.js';
import { createEmailProviderRegistry } from '../../../src/infrastructure/providers/registry.js';
import { createSecretResolver } from '../../../src/infrastructure/security/secret-resolver.js';
import {
  emailBody,
  FakeApiKeys,
  FakeManualRetries,
  FakeNotifications,
  FakeProviderConfig,
  FakeProviderEvents,
  FakeSenderPolicy,
  instance,
  nextId,
  WEBHOOK_SECRET,
} from './support/fakes.js';

/** In-memory fixed window (never expires during a test) with the same semantics as Valkey. */
class CountingLimiter implements RateLimiter {
  readonly counts = new Map<string, number>();
  consume(key: string, limit: number): Promise<RateLimitDecision> {
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return Promise.resolve({ allowed: count <= limit, retryAfterMs: 5_000 });
  }
  peek(key: string, limit: number): Promise<RateLimitDecision> {
    return Promise.resolve({ allowed: (this.counts.get(key) ?? 0) < limit, retryAfterMs: 5_000 });
  }
}

class CountingApiKeys extends FakeApiKeys {
  lookups = 0;
  hang = false;
  override findByPrefix(keyPrefix: string): Promise<ApiKeyRecord | null> {
    this.lookups += 1;
    if (this.hang) return new Promise(() => undefined);
    return super.findByPrefix(keyPrefix);
  }
}

interface Harness {
  app: FastifyInstance;
  apiKeys: CountingApiKeys;
  limiter: CountingLimiter;
  providerConfig: FakeProviderConfig;
  notifications: FakeNotifications;
  events: FakeProviderEvents;
}

async function harness(http?: HttpServerOptions): Promise<Harness> {
  const apiKeys = new CountingApiKeys();
  const limiter = new CountingLimiter();
  const providerConfig = new FakeProviderConfig();
  const notifications = new FakeNotifications();
  const events = new FakeProviderEvents();
  const app = await buildApp({
    logger: false,
    readiness: () => Promise.resolve({ ready: true, checks: {} }),
    ...(http === undefined ? {} : { http }),
    api: createApiDependencies({
      notifications,
      manualRetries: new FakeManualRetries(),
      apiKeys,
      providerConfig,
      providerEvents: events,
      senderPolicy: new FakeSenderPolicy(),
      registry: createEmailProviderRegistry({}),
      secrets: createSecretResolver({
        env: { RESEND_TEST_API_KEY: 're_test', RESEND_TEST_WEBHOOK_SECRET: WEBHOOK_SECRET },
      }),
      rateLimiter: limiter,
      backlog: new BacklogGuard(() => Promise.resolve(0), 100, 0),
      logger: pino({ level: 'silent' }),
      ingressLimit: { limit: 100, windowMs: 1_000 },
      webhookLimit: { limit: 2, windowMs: 1_000 },
      webhookInvalidLimit: { limit: 3, windowMs: 60_000 },
      authFailureLimit: { limit: 4, windowMs: 60_000 },
      readLimit: { limit: 2, windowMs: 1_000 },
    }),
  });
  return { app, apiKeys, limiter, providerConfig, notifications, events };
}

const ALL = ['notifications:write', 'notifications:read', 'notifications:retry'] as const;

describe('sender allow-list bypass attempts over HTTP', () => {
  it.each([
    '<evil@attacker.test> <orders@example.test>',
    'evil@attacker.test, <orders@example.test>',
    'Shop <orders@example.test>, evil@attacker.test',
    'Shop\r\nBcc: x@attacker.test <orders@example.test>',
    'evil@attacker.test <orders@example.test>',
  ])('rejects %j with 400 and stores nothing', async (from) => {
    const h = await harness();
    const tenantId = nextId();
    const key = h.apiKeys.add(tenantId, [...ALL]);
    h.providerConfig.addPolicy(tenantId, [instance(tenantId)]);
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/notifications',
      headers: { authorization: `Bearer ${key}`, 'idempotency-key': 'bypass' },
      payload: emailBody({ content: { from, subject: 's', text: 't' } }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('validation_error');
    expect(h.notifications.byId.size).toBe(0);
  });
});

describe('per-IP budget of failed authentications', () => {
  let h: Harness;
  let key: string;

  beforeEach(async () => {
    h = await harness();
    key = h.apiKeys.add(nextId(), [...ALL]);
  });

  const get = (bearer: string | undefined, remoteAddress = '10.0.0.1') =>
    h.app.inject({
      method: 'GET',
      url: `/v1/notifications/${nextId()}`,
      remoteAddress,
      headers: bearer === undefined ? {} : { authorization: `Bearer ${bearer}` },
    });

  it('sheds an IP with 429 before any key lookup once its failures exceed the budget', async () => {
    const unknown = `ns_0123456789ab_${'x'.repeat(43)}`;
    for (let i = 0; i < 4; i += 1) expect((await get(unknown)).statusCode).toBe(401);
    const lookups = h.apiKeys.lookups;

    const blocked = await get(unknown);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBe('5');
    // Even a valid key from the same IP is shed without reaching the database.
    expect((await get(key)).statusCode).toBe(429);
    expect(h.apiKeys.lookups).toBe(lookups);
    // Other clients are unaffected.
    expect((await get(key, '10.0.0.2')).statusCode).toBe(404);
  });

  it('counts missing credentials but never successful requests', async () => {
    for (let i = 0; i < 10; i += 1) {
      const res = await get(key);
      expect(res.statusCode === 404 || res.statusCode === 429).toBe(true);
    }
    expect(h.limiter.counts.get('authfail:10.0.0.1')).toBeUndefined();
    expect((await get(undefined)).statusCode).toBe(401);
    expect(h.limiter.counts.get('authfail:10.0.0.1')).toBe(1);
  });
});

describe('per-tenant read limit', () => {
  it('limits GET routes per tenant without touching the write budget', async () => {
    const h = await harness();
    const tenantId = nextId();
    const key = h.apiKeys.add(tenantId, [...ALL]);
    h.providerConfig.addPolicy(tenantId, [instance(tenantId)]);
    const read = () =>
      h.app.inject({
        method: 'GET',
        url: '/v1/notifications',
        headers: { authorization: `Bearer ${key}` },
      });
    expect((await read()).statusCode).toBe(200);
    expect((await read()).statusCode).toBe(200);
    const limited = await read();
    expect(limited.statusCode).toBe(429);
    expect(limited.json<{ code: string }>().code).toBe('rate_limited');

    const write = await h.app.inject({
      method: 'POST',
      url: '/v1/notifications',
      headers: { authorization: `Bearer ${key}`, 'idempotency-key': 'w-1' },
      payload: emailBody(),
    });
    expect(write.statusCode).toBe(202);
    expect(h.limiter.counts.get(`read:${tenantId}`)).toBe(3);
  });
});

describe('webhook budgets', () => {
  const EVENT = JSON.stringify({
    type: 'email.delivered',
    created_at: '2026-10-18T10:00:00.000Z',
    data: { email_id: 'em_1', to: ['c@example.org'] },
  });
  const signed = (secret = WEBHOOK_SECRET) => {
    const id = `msg_${randomUUID()}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    return {
      'content-type': 'application/json',
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': `v1,${signSvixPayload(secret, id, timestamp, Buffer.from(EVENT))}`,
    };
  };
  const FORGED = 'whsec_' + Buffer.from('attacker-secret').toString('base64');

  let h: Harness;
  let instanceId: number;

  beforeEach(async () => {
    h = await harness();
    const resend = instance(nextId(), {
      providerType: 'resend',
      config: {},
      secretRef: 'env:RESEND_TEST',
    });
    h.providerConfig.instances.push(resend);
    instanceId = resend.id;
  });

  const post = (headers: Record<string, string>, remoteAddress: string, id = instanceId) =>
    h.app.inject({
      method: 'POST',
      url: `/v1/webhooks/resend/${id}`,
      remoteAddress,
      headers,
      payload: EVENT,
    });

  it('never charges forged calls to the verified budget of the instance', async () => {
    // Forged flood from many IPs (each within its own per-IP budget).
    for (let i = 0; i < 3; i += 1) {
      expect((await post(signed(FORGED), `203.0.113.${i}`)).statusCode).toBe(401);
    }
    expect(h.limiter.counts.get(`webhook:${instanceId}`)).toBeUndefined();
    // The real provider still gets its whole verified budget (2 per window).
    expect((await post(signed(), '198.51.100.7')).statusCode).toBe(200);
    expect((await post(signed(), '198.51.100.7')).statusCode).toBe(200);
    expect((await post(signed(), '198.51.100.7')).statusCode).toBe(429);
    expect(h.events.events).toHaveLength(2);
  });

  it('answers 429 to invalid calls once the per-instance invalid budget is exhausted', async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await post(signed(FORGED), `203.0.113.${i}`)).statusCode).toBe(401);
    }
    expect((await post(signed(FORGED), '203.0.113.50')).statusCode).toBe(429);
    // Verified calls are still accepted.
    expect((await post(signed(), '198.51.100.7')).statusCode).toBe(200);
  });

  it('sheds an IP that keeps failing before any lookup, without affecting the provider', async () => {
    for (let i = 0; i < 4; i += 1) {
      const res = await post(signed(), '203.0.113.9', nextId());
      expect(res.statusCode).toBe(404);
    }
    expect((await post(signed(), '203.0.113.9')).statusCode).toBe(429);
    expect((await post(signed(), '198.51.100.7')).statusCode).toBe(200);
  });
});

describe('HTTP processing timeout', () => {
  it('answers 503 dependency_unavailable when a request hangs', async () => {
    const h = await harness({ handlerTimeoutMs: 200, requestTimeoutMs: 1_000 });
    const key = h.apiKeys.add(nextId(), [...ALL]);
    h.apiKeys.hang = true;
    const res = await h.app.inject({
      method: 'GET',
      url: '/v1/notifications',
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json<{ code: string }>().code).toBe('dependency_unavailable');
    await h.app.close();
  });
});
