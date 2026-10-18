import type { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvalidCursorError } from '../../../src/application/ports/lookup-repositories.js';
import { PgNotificationRepository } from '../../../src/infrastructure/database/notification-repository.js';
import {
  closeOrm,
  createTenantFixture,
  migratedOrm,
  notificationInput,
  queryRows,
  type TenantFixture,
} from './support.js';

describe('PgNotificationRepository', () => {
  let orm: MikroORM;
  let repo: PgNotificationRepository;

  beforeAll(async () => {
    orm = await migratedOrm();
    repo = new PgNotificationRepository(orm);
  });

  afterAll(closeOrm);

  async function createOrThrow(fixture: TenantFixture, key?: string): Promise<number> {
    const result = await repo.create(
      notificationInput(fixture, key === undefined ? {} : { idempotencyKey: key }),
    );
    if (result.kind !== 'created') throw new Error(`expected created, got ${result.kind}`);
    return result.notificationId;
  }

  it('creates notification, pending delivery and generation-1 outbox event together', async () => {
    const fixture = await createTenantFixture(orm);
    const id = await createOrThrow(fixture);

    const deliveries = await queryRows(
      orm,
      `select submission_status, receipt_status, generation, attempts_used, max_attempts, recipient
       from deliveries where tenant_id = ? and notification_id = ?`,
      [fixture.tenantId, id],
    );
    expect(deliveries).toEqual([
      {
        submission_status: 'pending',
        receipt_status: 'unavailable',
        generation: 1,
        attempts_used: 0,
        max_attempts: 3,
        recipient: 'recipient@example.test',
      },
    ]);
    const outbox = await queryRows(
      orm,
      `select o.generation, o.event_type, o.status, o.dispatch_count
       from outbox_events o join deliveries d on d.id = o.delivery_id
       where d.notification_id = ?`,
      [id],
    );
    expect(outbox).toEqual([
      { generation: 1, event_type: 'dispatch_delivery', status: 'pending', dispatch_count: 0 },
    ]);
  });

  it('replays the same notification for the same key and request hash', async () => {
    const fixture = await createTenantFixture(orm);
    const input = notificationInput(fixture);
    const first = await repo.create(input);
    const second = await repo.create(input);

    expect(first.kind).toBe('created');
    expect(second).toEqual({
      kind: 'replayed',
      notificationId: first.kind === 'created' ? first.notificationId : '',
    });
    const count = await queryRows(
      orm,
      `select count(*)::int as n from deliveries where tenant_id = ?`,
      [fixture.tenantId],
    );
    expect(count[0]?.n).toBe(1);
  });

  it('reports a conflict for the same key with a different request hash', async () => {
    const fixture = await createTenantFixture(orm);
    const input = notificationInput(fixture);
    await repo.create(input);

    expect(await repo.create({ ...input, requestHash: 'hash-b' })).toEqual({ kind: 'conflict' });
  });

  it('scopes idempotency keys per tenant', async () => {
    const a = await createTenantFixture(orm);
    const b = await createTenantFixture(orm);
    const resultA = await repo.create(notificationInput(a, { idempotencyKey: 'shared-key' }));
    const resultB = await repo.create(notificationInput(b, { idempotencyKey: 'shared-key' }));

    expect(resultA.kind).toBe('created');
    expect(resultB.kind).toBe('created');
  });

  it('creates exactly one notification for concurrent identical requests', async () => {
    const fixture = await createTenantFixture(orm);
    const input = notificationInput(fixture);

    const results = await Promise.all(Array.from({ length: 8 }, () => repo.create(input)));

    const created = results.filter((r) => r.kind === 'created');
    const replayed = results.filter((r) => r.kind === 'replayed');
    expect(created).toHaveLength(1);
    expect(replayed).toHaveLength(7);
    const ids = new Set(results.map((r) => (r.kind === 'conflict' ? null : r.notificationId)));
    expect(ids.size).toBe(1);
    const counts = await queryRows(
      orm,
      `select (select count(*) from notifications where tenant_id = ?)::int as notifications,
              (select count(*) from outbox_events where tenant_id = ?)::int as outbox`,
      [fixture.tenantId, fixture.tenantId],
    );
    expect(counts[0]).toEqual({ notifications: 1, outbox: 1 });
  });

  it('lets one of concurrent requests win and reports conflicts for different payloads', async () => {
    const fixture = await createTenantFixture(orm);
    const input = notificationInput(fixture);

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => repo.create({ ...input, requestHash: `hash-${i}` })),
    );

    expect(results.filter((r) => r.kind === 'created')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'conflict')).toHaveLength(5);
  });

  it('returns details with attempts only to the owning tenant', async () => {
    const owner = await createTenantFixture(orm);
    const other = await createTenantFixture(orm);
    const id = await createOrThrow(owner);

    const detail = await repo.findById(owner.tenantId, id);
    expect(detail).toMatchObject({
      id,
      channel: 'email',
      routingKey: 'transactional',
      submissionStatus: 'pending',
      receiptStatus: 'unavailable',
      attempts: [],
      lastError: null,
    });
    expect(detail?.createdAt).toBeInstanceOf(Date);
    expect(await repo.findById(other.tenantId, id)).toBeNull();
    expect(await repo.findById(owner.tenantId, Number.MAX_SAFE_INTEGER)).toBeNull();
  });

  it('pages through notifications newest first with an opaque cursor', async () => {
    const fixture = await createTenantFixture(orm);
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push(await createOrThrow(fixture));

    const seen: number[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const result = await repo.list(fixture.tenantId, {
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...result.items.map((i) => i.id));
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }

    expect(seen).toHaveLength(5);
    expect(new Set(seen)).toEqual(new Set(ids));
    const created = await queryRows(
      orm,
      `select id from notifications where tenant_id = ? order by created_at desc, id desc`,
      [fixture.tenantId],
    );
    expect(seen).toEqual(created.map((r) => r.id));
  });

  it('lists only the tenant own notifications and applies filters', async () => {
    const owner = await createTenantFixture(orm);
    const other = await createTenantFixture(orm);
    const ownId = await createOrThrow(owner);
    await createOrThrow(other);

    const own = await repo.list(owner.tenantId, { limit: 50 });
    expect(own.items.map((i) => i.id)).toEqual([ownId]);
    expect(own.nextCursor).toBeNull();

    expect((await repo.list(owner.tenantId, { limit: 50, status: 'accepted' })).items).toEqual([]);
    expect((await repo.list(owner.tenantId, { limit: 50, channel: 'sms' })).items).toEqual([]);
    expect(
      (await repo.list(owner.tenantId, { limit: 50, createdFrom: new Date(Date.now() + 60_000) }))
        .items,
    ).toEqual([]);
  });

  it('rejects malformed cursors', async () => {
    const fixture = await createTenantFixture(orm);
    await expect(
      repo.list(fixture.tenantId, { limit: 10, cursor: 'not-a-cursor' }),
    ).rejects.toBeInstanceOf(InvalidCursorError);
  });

  it('counts outbox events not yet published', async () => {
    const before = await repo.countPendingOutbox();
    const fixture = await createTenantFixture(orm);
    await createOrThrow(fixture);
    expect(await repo.countPendingOutbox()).toBe(before + 1);
  });

  it('does not count events scheduled in the future (retry backoff, deferrals)', async () => {
    const fixture = await createTenantFixture(orm);
    const notificationId = await createOrThrow(fixture);
    const before = await repo.countPendingOutbox();
    await queryRows(
      orm,
      `update outbox_events set available_at = now() + interval '5 minutes'
       where delivery_id = (select id from deliveries where notification_id = ?)`,
      [notificationId],
    );
    expect(await repo.countPendingOutbox()).toBe(before - 1);
  });
});
