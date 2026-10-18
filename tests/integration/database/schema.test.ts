import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgNotificationRepository } from '../../../src/infrastructure/database/notification-repository.js';
import {
  createTenantFixture,
  notificationInput,
  queryRows,
  resetDatabase,
  testOrmOptions,
} from './support.js';

/** Composite (tenant_id, x_id) foreign keys exist only in SQL: MikroORM cannot model them. */
const SQL_ONLY_FOREIGN_KEYS = [
  'api_keys_tenant_id_foreign',
  'audit_events_tenant_id_foreign',
  'deliveries_notification_foreign',
  'delivery_attempts_delivery_foreign',
  'delivery_attempts_provider_instance_foreign',
  'notifications_routing_policy_foreign',
  'notifications_tenant_id_foreign',
  'outbox_events_delivery_foreign',
  'provider_events_delivery_foreign',
  'provider_events_provider_instance_foreign',
  'provider_instances_tenant_id_foreign',
  'routing_policies_tenant_id_foreign',
  'routing_policy_providers_instance_foreign',
  'routing_policy_providers_policy_foreign',
  'suppressions_provider_event_foreign',
  'suppressions_tenant_id_foreign',
].sort();

describe('database schema', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(testOrmOptions());
    await resetDatabase(orm);
  });

  afterAll(async () => {
    await orm.close();
  });

  it('applies every migration on an empty database and has nothing pending', async () => {
    const applied = await orm.migrator.up();
    expect(applied.map((m) => m.name)).toEqual([
      'Migration20261017000000_initial_schema',
      'Migration20261018000000_provider_instance_limits',
    ]);
    expect(await orm.migrator.getPending()).toEqual([]);

    const tables = await queryRows(
      orm,
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_name <> 'mikro_orm_migrations'
       order by table_name`,
    );
    expect(tables.map((t) => t.table_name)).toEqual([
      'api_keys',
      'audit_events',
      'deliveries',
      'delivery_attempts',
      'notifications',
      'outbox_events',
      'provider_events',
      'provider_instances',
      'routing_policies',
      'routing_policy_providers',
      'suppressions',
      'tenants',
    ]);
  });

  it('matches the ORM metadata except for the SQL-only composite foreign keys', async () => {
    const diff = await orm.schema.getUpdateSchemaSQL({ wrap: false });
    const statements = diff
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    const droppedForeignKeys = statements
      .map((line) => /^alter table "\w+" drop constraint "(\w+_foreign)";$/.exec(line)?.[1])
      .filter((name): name is string => name !== undefined)
      .sort();

    expect(droppedForeignKeys).toEqual(SQL_ONLY_FOREIGN_KEYS);
    expect(statements).toHaveLength(SQL_ONLY_FOREIGN_KEYS.length);
  });

  it('gives existing and new provider instances empty limits by default', async () => {
    const fixture = await createTenantFixture(orm);
    const rows = await queryRows(orm, `select limits from provider_instances where id = ?`, [
      fixture.providerInstanceId,
    ]);
    expect(rows).toEqual([{ limits: {} }]);
  });

  it('rejects submission statuses outside the contract', async () => {
    const fixture = await createTenantFixture(orm);
    const created = await new PgNotificationRepository(orm).create(notificationInput(fixture));
    if (created.kind !== 'created') throw new Error('expected created');

    await expect(
      queryRows(
        orm,
        `update deliveries set submission_status = 'delivered' where notification_id = ?`,
        [created.notificationId],
      ),
    ).rejects.toThrow(/deliveries_submission_status_check/);
  });

  it('rejects a delivery linked to a notification of another tenant', async () => {
    const owner = await createTenantFixture(orm);
    const other = await createTenantFixture(orm);
    const created = await new PgNotificationRepository(orm).create(notificationInput(owner));
    if (created.kind !== 'created') throw new Error('expected created');

    await expect(
      queryRows(
        orm,
        `insert into deliveries (tenant_id, notification_id, channel, recipient, max_attempts, expires_at)
         values (?, ?, 'email', 'x@example.test', 1, now())`,
        [other.tenantId, created.notificationId],
      ),
    ).rejects.toThrow(/deliveries_notification_foreign/);
  });

  it('assigns ids from identity columns and refuses explicit ones', async () => {
    const first = await createTenantFixture(orm);
    const second = await createTenantFixture(orm);
    expect(Number.isSafeInteger(first.tenantId) && first.tenantId > 0).toBe(true);
    expect(second.tenantId).toBeGreaterThan(first.tenantId);

    await expect(
      queryRows(orm, `insert into tenants (id, slug, name) values (?, ?, 'Explicit id')`, [
        second.tenantId + 1000,
        `explicit-${second.tenantId}`,
      ]),
    ).rejects.toThrow(/generated always/i);
  });

  it('rejects routing a policy to a provider instance of another tenant', async () => {
    const owner = await createTenantFixture(orm);
    const other = await createTenantFixture(orm);

    await expect(
      queryRows(
        orm,
        `insert into routing_policy_providers (routing_policy_id, position, tenant_id, provider_instance_id)
         values (?, 1, ?, ?)`,
        [owner.routingPolicyId, owner.tenantId, other.providerInstanceId],
      ),
    ).rejects.toThrow(/routing_policy_providers_instance_foreign/);
  });
});
