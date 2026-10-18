import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../../src/config/env.js';
import { ormConfig } from '../../../src/infrastructure/database/orm-config.js';
import type { CreateNotificationInput } from '../../../src/application/ports/repositories.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://notifications:notifications@localhost:5432/notifications_test';

export function testOrmOptions() {
  const config = loadConfig({
    APP_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    DATABASE_POOL_MAX: '10',
    VALKEY_URL: 'redis://localhost:6379',
  });
  return ormConfig(config);
}

/** Drops every object in the public schema, so migrations start from an empty database. */
export async function resetDatabase(orm: MikroORM): Promise<void> {
  await orm.em.fork().execute('drop schema if exists public cascade; create schema public;');
}

let shared: Promise<MikroORM> | undefined;

/**
 * Returns an ORM connected to the test database with migrations applied once per test file.
 * Tests isolate their data by creating their own tenants (see createTenantFixture).
 */
export function migratedOrm(): Promise<MikroORM> {
  shared ??= (async () => {
    const orm = await MikroORM.init(testOrmOptions());
    await resetDatabase(orm);
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

export interface TenantFixture {
  tenantId: number;
  providerInstanceId: number;
  routingPolicyId: number;
}

/** Id returned by an `insert ... returning id`. */
export function insertedId(rows: Record<string, unknown>[]): number {
  const id = rows[0]?.id;
  if (typeof id !== 'number') throw new Error('insert returned no id');
  return id;
}

export async function createTenantFixture(orm: MikroORM): Promise<TenantFixture> {
  const em = orm.em.fork();
  return em.transactional(async (tx) => {
    const tenantId = insertedId(
      await tx.execute(`insert into tenants (slug, name) values (?, ?) returning id`, [
        `tenant-${randomUUID()}`,
        'Test tenant',
      ]),
    );
    const providerInstanceId = insertedId(
      await tx.execute(
        `insert into provider_instances (tenant_id, name, provider_type, channel, config, secret_ref)
         values (?, 'smtp-main', 'smtp', 'email', ?::jsonb, 'smtp-main') returning id`,
        [tenantId, JSON.stringify({ host: 'localhost', port: 1025 })],
      ),
    );
    const routingPolicyId = insertedId(
      await tx.execute(
        `insert into routing_policies (tenant_id, routing_key, channel, version, max_attempts)
         values (?, 'transactional', 'email', 1, 3) returning id`,
        [tenantId],
      ),
    );
    await tx.execute(
      `insert into routing_policy_providers (routing_policy_id, position, tenant_id, provider_instance_id)
       values (?, 0, ?, ?)`,
      [routingPolicyId, tenantId, providerInstanceId],
    );
    return { tenantId, providerInstanceId, routingPolicyId };
  });
}

export function notificationInput(
  fixture: TenantFixture,
  overrides: Partial<CreateNotificationInput> = {},
): CreateNotificationInput {
  return {
    tenantId: fixture.tenantId,
    idempotencyKey: `key-${randomUUID()}`,
    requestHash: 'hash-a',
    routingKey: 'transactional',
    payload: {
      channel: 'email',
      recipient: { email: 'recipient@example.test' },
      content: { from: 'sender@example.test', subject: 'Hello', text: 'Body' },
    },
    metadata: { orderId: '123' },
    routing: {
      policyId: fixture.routingPolicyId,
      policyVersion: 1,
      platform: null,
      providerInstanceIds: [fixture.providerInstanceId],
      fallbackEnabled: true,
      maxAttempts: 3,
    },
    expiresAt: new Date(Date.now() + 24 * 3600_000),
    ...overrides,
  };
}

/** Removes all rows; used by files whose operations are global (outbox claims, stale scans). */
export async function truncateAll(orm: MikroORM): Promise<void> {
  await orm.em.fork().execute(
    `truncate audit_events, suppressions, provider_events, outbox_events, delivery_attempts,
        deliveries, notifications, routing_policy_providers, routing_policies, provider_instances,
        api_keys, tenants`,
  );
}

export async function queryRows(
  orm: MikroORM,
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  return orm.em.fork().execute(sql, params);
}

/** Delivery id of a notification created through the repository. */
export async function deliveryIdOf(orm: MikroORM, notificationId: number): Promise<number> {
  const found = await queryRows(orm, `select id from deliveries where notification_id = ?`, [
    notificationId,
  ]);
  const id = found[0]?.id;
  if (typeof id !== 'number') throw new Error('delivery not found');
  return id;
}
