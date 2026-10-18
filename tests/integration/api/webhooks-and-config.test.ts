import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyConfig } from '../../../src/application/admin/apply-config.js';
import { parseConfigFile } from '../../../src/application/admin/config-file.js';
import { ValkeyRateLimiter } from '../../../src/http/rate-limit/valkey-rate-limiter.js';
import { PgApiKeyAdminLookup } from '../../../src/infrastructure/database/api-support-repositories.js';
import { createRepositories } from '../../../src/infrastructure/database/repositories.js';
import { signSvixPayload } from '../../../src/infrastructure/providers/email/resend-webhook.js';
import { createEmailProviderRegistry } from '../../../src/infrastructure/providers/registry.js';
import { createProducerConnection } from '../../../src/infrastructure/queue/valkey-connection.js';
import { generateApiKey } from '../../../src/infrastructure/security/api-keys.js';
import {
  buildHarness,
  closeOrm,
  createRequest,
  migratedOrm,
  queryRows,
  setupTenant,
  WEBHOOK_SECRET,
  type ApiHarness,
  type TenantSetup,
} from './support.js';

const TEST_VALKEY_URL = process.env.TEST_VALKEY_URL ?? 'redis://localhost:6379/1';

function signed(body: string, id: string, secret = WEBHOOK_SECRET) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    'content-type': 'application/json',
    'svix-id': id,
    'svix-timestamp': timestamp,
    'svix-signature': `v1,${signSvixPayload(secret, id, timestamp, Buffer.from(body))}`,
  };
}

describe('webhooks, config:apply and rate limiting against real infrastructure', () => {
  let orm: MikroORM;
  let h: ApiHarness;
  let tenant: TenantSetup;

  beforeAll(async () => {
    orm = await migratedOrm();
    h = await buildHarness(orm);
    tenant = await setupTenant(orm);
  });

  afterAll(async () => {
    await h.app.close();
    await closeOrm();
  });

  describe('POST /v1/webhooks/resend/:instanceId', () => {
    const body = JSON.stringify({
      type: 'email.bounced',
      created_at: '2026-10-18T09:00:00.000Z',
      data: { email_id: 'em_it_1', to: ['customer@example.org'], bounce: { type: 'Permanent' } },
    });
    const url = () => `/v1/webhooks/resend/${tenant.instanceIds.resend}`;

    it('persists a verified event with the instance tenant and answers 200 (duplicates too)', async () => {
      const headers = signed(body, 'msg_it_1');
      const res = await h.app.inject({ method: 'POST', url: url(), headers, payload: body });
      expect(res.statusCode).toBe(200);
      const again = await h.app.inject({ method: 'POST', url: url(), headers, payload: body });
      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual({ received: 1, duplicates: 1 });

      const rows = await queryRows(
        orm,
        `select tenant_id, event_type, external_message_id, delivery_id, processed_at, payload
         from provider_events where provider_instance_id = ?`,
        [tenant.instanceIds.resend],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tenant_id: tenant.tenantId,
        event_type: 'bounced_hard',
        external_message_id: 'em_it_1',
        delivery_id: null,
        processed_at: null,
      });
      expect(JSON.stringify(rows[0]?.payload)).not.toContain('customer@example.org');
    });

    it('rejects invalid signatures with 401 and stores nothing', async () => {
      const wrong = 'whsec_' + Buffer.from('not-the-secret').toString('base64');
      const res = await h.app.inject({
        method: 'POST',
        url: url(),
        headers: signed(body, 'msg_it_bad', wrong),
        payload: body,
      });
      expect(res.statusCode).toBe(401);
      const rows = await queryRows(
        orm,
        `select count(*)::int as count from provider_events where external_event_id = 'msg_it_bad'`,
      );
      expect(rows[0]?.count).toBe(0);
    });

    it('does not resolve instances through another provider type', async () => {
      const res = await h.app.inject({
        method: 'POST',
        url: `/v1/webhooks/smtp/${tenant.instanceIds.resend}`,
        headers: signed(body, 'msg_it_2'),
        payload: body,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('config:apply', () => {
    function deps(appEnv = 'local') {
      return {
        admin: createRepositories(orm).adminConfig,
        apiKeys: new PgApiKeyAdminLookup(orm),
        providers: createEmailProviderRegistry(),
        generateApiKey,
        appEnv,
        actor: 'config:apply',
      };
    }

    it('applies the local example idempotently and the printed key authenticates', async () => {
      const file = parseConfigFile(JSON.parse(await readFile('config/local.example.json', 'utf8')));
      const first = await applyConfig(file, deps());
      expect(first.createdApiKeys).toHaveLength(1);
      const auditBefore = await queryRows(orm, `select count(*)::int as count from audit_events`);

      const second = await applyConfig(file, deps());
      expect(second.changed).toEqual({
        tenants: 0,
        apiKeys: 0,
        providerInstances: 0,
        routingPolicies: 0,
      });
      expect(second.createdApiKeys).toEqual([]);
      const auditAfter = await queryRows(orm, `select count(*)::int as count from audit_events`);
      expect(auditAfter[0]?.count).toBe(auditBefore[0]?.count);

      const stored = await queryRows(
        orm,
        `select key_hash from api_keys where name = 'local-app-key'`,
      );
      expect(String(stored[0]?.key_hash)).toMatch(/^sha256:[0-9a-f]{64}$/);

      const plaintext = first.createdApiKeys[0]?.plaintext ?? '';
      const res = await createRequest(h.app, plaintext, 'local-1', {
        channel: 'email',
        routingKey: 'transactional',
        recipient: { email: 'someone@example.org' },
        content: { from: 'no-reply@example.test', subject: 'Hi', text: 'Hello' },
      });
      expect(res.statusCode).toBe(202);
    });

    it('rejects the local example in production without writing', async () => {
      const raw = JSON.parse(await readFile('config/local.example.json', 'utf8')) as {
        tenants: { slug: string }[];
      };
      const slug = `prod-${randomUUID().slice(0, 8)}`;
      if (raw.tenants[0]) raw.tenants[0].slug = slug;
      await expect(applyConfig(parseConfigFile(raw), deps('production'))).rejects.toThrow(
        /profile "local" is not allowed/,
      );
      const rows = await queryRows(
        orm,
        `select count(*)::int as count from tenants where slug = ?`,
        [slug],
      );
      expect(rows[0]?.count).toBe(0);
    });
  });

  describe('ingress rate limiting on Valkey', () => {
    it('limits per tenant with an atomic shared counter', async () => {
      const redis = createProducerConnection(TEST_VALKEY_URL);
      try {
        if (redis.status !== 'ready') await new Promise((resolve) => redis.once('ready', resolve));
        const limited = await buildHarness(orm, {
          rateLimiter: new ValkeyRateLimiter(redis, `it:${randomUUID()}:`),
        });
        try {
          const target = await setupTenant(orm);
          const statuses: number[] = [];
          // Default limit: 100 requests per second per tenant.
          const responses = await Promise.all(
            Array.from({ length: 110 }, (_, i) =>
              createRequest(limited.app, target.keys.all ?? '', `rl-${i}`),
            ),
          );
          for (const r of responses) statuses.push(r.statusCode);
          expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
          expect(statuses.filter((s) => s === 202).length).toBeLessThanOrEqual(100);
        } finally {
          await limited.app.close();
        }
      } finally {
        redis.disconnect();
      }
    });

    it('charges forged webhooks and failed logins to separate Valkey budgets', async () => {
      const redis = createProducerConnection(TEST_VALKEY_URL);
      try {
        if (redis.status !== 'ready') await new Promise((resolve) => redis.once('ready', resolve));
        const guarded = await buildHarness(orm, {
          rateLimiter: new ValkeyRateLimiter(redis, `it:${randomUUID()}:`),
          guards: {
            webhookLimit: { limit: 2, windowMs: 60_000 },
            webhookInvalidLimit: { limit: 100, windowMs: 60_000 },
            authFailureLimit: { limit: 3, windowMs: 60_000 },
          },
        });
        try {
          const body = JSON.stringify({
            type: 'email.delivered',
            created_at: '2026-10-18T09:00:00.000Z',
            data: { email_id: `em_${randomUUID()}` },
          });
          const forged = 'whsec_' + Buffer.from('forged').toString('base64');
          const url = `/v1/webhooks/resend/${tenant.instanceIds.resend}`;
          for (let i = 0; i < 5; i += 1) {
            const res = await guarded.app.inject({
              method: 'POST',
              url,
              remoteAddress: `203.0.113.${i}`,
              headers: signed(body, `msg_forged_${i}`, forged),
              payload: body,
            });
            expect(res.statusCode).toBe(401);
          }
          for (const id of ['msg_real_1', 'msg_real_2']) {
            const res = await guarded.app.inject({
              method: 'POST',
              url,
              remoteAddress: '198.51.100.1',
              headers: signed(body, id),
              payload: body,
            });
            expect(res.statusCode).toBe(200);
          }

          // Failed logins: the 4th attempt from the IP is shed before the key lookup.
          const statuses: number[] = [];
          for (let i = 0; i < 4; i += 1) {
            const res = await createRequest(
              guarded.app,
              `ns_0123456789ab_${'x'.repeat(43)}`,
              `f-${i}`,
            );
            statuses.push(res.statusCode);
          }
          expect(statuses).toEqual([401, 401, 401, 429]);
        } finally {
          await guarded.app.close();
        }
      } finally {
        redis.disconnect();
      }
    });

    it('keeps accepting when Valkey is unreachable', async () => {
      const redis = new Redis('redis://127.0.0.1:1', {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 0,
      });
      const limited = await buildHarness(orm, { rateLimiter: new ValkeyRateLimiter(redis) });
      try {
        const res = await createRequest(limited.app, tenant.keys.all ?? '', 'valkey-down-1');
        expect(res.statusCode).toBe(202);
      } finally {
        await limited.app.close();
        redis.disconnect();
      }
    });
  });
});
