import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { loadConfig } from '../../../src/config/env.js';
import { applyConfig } from '../../../src/application/admin/apply-config.js';
import { parseConfigFile } from '../../../src/application/admin/config-file.js';
import type { RateLimiter } from '../../../src/application/notifications/ports.js';
import { BacklogGuard } from '../../../src/application/notifications/ingress-guards.js';
import { createApiDependencies } from '../../../src/http/api-dependencies.js';
import { buildApp } from '../../../src/http/app.js';
import {
  PgApiKeyAdminLookup,
  PgSenderPolicyRepository,
} from '../../../src/infrastructure/database/api-support-repositories.js';
import { PgManualRetryRepository } from '../../../src/infrastructure/database/manual-retry-repository.js';
import { ormConfig } from '../../../src/infrastructure/database/orm-config.js';
import {
  createRepositories,
  type Repositories,
} from '../../../src/infrastructure/database/repositories.js';
import { createEmailProviderRegistry } from '../../../src/infrastructure/providers/registry.js';
import { generateApiKey } from '../../../src/infrastructure/security/api-keys.js';
import { createSecretResolver } from '../../../src/infrastructure/security/secret-resolver.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://notifications:notifications@localhost:5432/notifications_test';

export const WEBHOOK_SECRET =
  'whsec_' + Buffer.from('integration-webhook-secret').toString('base64');
/** Secret values for `env:RESEND_IT` instances (never real credentials). */
export const TEST_SECRET_ENV = {
  RESEND_IT_API_KEY: 're_test_placeholder',
  RESEND_IT_WEBHOOK_SECRET: WEBHOOK_SECRET,
};

let shared: Promise<MikroORM> | undefined;

/** ORM on the test database; the schema is dropped and migrated once per test file. */
export function migratedOrm(): Promise<MikroORM> {
  shared ??= (async () => {
    const config = loadConfig({
      APP_ENV: 'test',
      DATABASE_URL: TEST_DATABASE_URL,
      DATABASE_POOL_MAX: '20',
      VALKEY_URL: 'redis://localhost:6379',
    });
    const orm = await MikroORM.init(ormConfig(config));
    await orm.em.fork().execute('drop schema if exists public cascade; create schema public;');
    await orm.migrator.up();
    return orm;
  })();
  return shared;
}

export async function closeOrm(): Promise<void> {
  if (shared) {
    const orm = await shared;
    shared = undefined;
    await orm.close();
  }
}

export interface ApiHarness {
  app: FastifyInstance;
  orm: MikroORM;
  repositories: Repositories;
}

export async function buildHarness(
  orm: MikroORM,
  options: {
    rateLimiter?: RateLimiter | null;
    backlogLimit?: number;
    /** Optional guards (off by default, like in the other API tests). */
    guards?: Pick<
      Parameters<typeof createApiDependencies>[0],
      'webhookLimit' | 'webhookInvalidLimit' | 'authFailureLimit' | 'readLimit'
    >;
  } = {},
): Promise<ApiHarness> {
  const repositories = createRepositories(orm);
  const app = await buildApp({
    logger: false,
    readiness: () => Promise.resolve({ ready: true, checks: {} }),
    api: createApiDependencies({
      notifications: repositories.notifications,
      manualRetries: new PgManualRetryRepository(orm),
      apiKeys: repositories.apiKeys,
      providerConfig: repositories.providerConfig,
      providerEvents: repositories.providerEvents,
      senderPolicy: new PgSenderPolicyRepository(orm),
      registry: createEmailProviderRegistry(),
      secrets: createSecretResolver({ env: TEST_SECRET_ENV }),
      rateLimiter: options.rateLimiter ?? null,
      backlog: new BacklogGuard(
        () => repositories.notifications.countPendingOutbox(),
        options.backlogLimit ?? 1_000_000,
        0,
      ),
      logger: pino({ level: 'silent' }),
      ingressLimit: { limit: 100, windowMs: 1_000 },
      webhookLimit: { limit: 200, windowMs: 1_000 },
      ...options.guards,
    }),
  });
  return { app, orm, repositories };
}

export interface TenantSetup {
  tenantId: number;
  slug: string;
  /** Plaintext keys by name: `all`, `read`, `write`, `retry`. */
  keys: Record<string, string>;
  instanceIds: Record<string, number>;
}

/** Creates a tenant through config:apply (SMTP + Resend instances, transactional policy). */
export async function setupTenant(orm: MikroORM): Promise<TenantSetup> {
  const slug = `t-${randomUUID().slice(0, 8)}`;
  const file = parseConfigFile({
    tenants: [
      {
        slug,
        name: `Tenant ${slug}`,
        allowedSenders: ['@example.test'],
        apiKeys: [
          {
            name: 'all',
            scopes: ['notifications:write', 'notifications:read', 'notifications:retry'],
          },
          { name: 'read', scopes: ['notifications:read'] },
          { name: 'write', scopes: ['notifications:write'] },
        ],
        providerInstances: [
          {
            name: 'smtp',
            providerType: 'smtp',
            channel: 'email',
            config: {
              host: 'localhost',
              port: 1025,
              tlsRequired: false,
              requireTLS: false,
              profile: 'local',
            },
          },
          {
            name: 'resend',
            providerType: 'resend',
            channel: 'email',
            config: { baseUrl: 'http://127.0.0.1:9', profile: 'local' },
            secretRef: 'env:RESEND_IT',
            enabled: false,
          },
        ],
        routingPolicies: [
          { routingKey: 'transactional', channel: 'email', maxAttempts: 3, providers: ['smtp'] },
        ],
      },
    ],
  });
  const repositories = createRepositories(orm);
  const result = await applyConfig(file, {
    admin: repositories.adminConfig,
    apiKeys: new PgApiKeyAdminLookup(orm),
    providers: createEmailProviderRegistry(),
    generateApiKey,
    appEnv: 'test',
    actor: 'test',
  });
  const keys = Object.fromEntries(result.createdApiKeys.map((k) => [k.name, k.plaintext]));
  const tenantRows = await queryRows(orm, `select id from tenants where slug = ?`, [slug]);
  const tenantId = Number(tenantRows[0]?.id);
  const instances = await queryRows(
    orm,
    `select id, name from provider_instances where tenant_id = ?`,
    [tenantId],
  );
  const instanceIds = Object.fromEntries(instances.map((r) => [String(r.name), Number(r.id)]));
  return { tenantId, slug, keys, instanceIds };
}

export function queryRows(
  orm: MikroORM,
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  return orm.em.fork().execute(sql, params);
}

export function emailBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channel: 'email',
    routingKey: 'transactional',
    recipient: { email: 'customer@example.org' },
    content: { from: 'Shop <shop@example.test>', subject: 'Order', text: 'Received' },
    metadata: { orderId: '1' },
    ...overrides,
  };
}

export function createRequest(
  app: FastifyInstance,
  key: string,
  idempotencyKey: string,
  body: Record<string, unknown> = emailBody(),
) {
  return app.inject({
    method: 'POST',
    url: '/v1/notifications',
    headers: { authorization: `Bearer ${key}`, 'idempotency-key': idempotencyKey },
    payload: body,
  });
}
