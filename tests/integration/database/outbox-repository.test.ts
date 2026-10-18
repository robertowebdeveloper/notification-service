import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgDeliveryRepository } from '../../../src/infrastructure/database/delivery-repository.js';
import { PgNotificationRepository } from '../../../src/infrastructure/database/notification-repository.js';
import { PgOutboxRepository } from '../../../src/infrastructure/database/outbox-repository.js';
import {
  closeOrm,
  createTenantFixture,
  deliveryIdOf,
  migratedOrm,
  notificationInput,
  queryRows,
  truncateAll,
} from './support.js';

const LEASE_MS = 30_000;

describe('PgOutboxRepository', () => {
  let orm: MikroORM;
  let outbox: PgOutboxRepository;
  let notifications: PgNotificationRepository;
  let deliveries: PgDeliveryRepository;

  beforeAll(async () => {
    orm = await migratedOrm();
    outbox = new PgOutboxRepository(orm);
    notifications = new PgNotificationRepository(orm);
    deliveries = new PgDeliveryRepository(orm);
  });

  // Claims are global (not tenant-scoped), so every test starts from an empty outbox.
  beforeEach(async () => {
    await truncateAll(orm);
  });

  afterAll(closeOrm);

  /** Availability, leases and staleness use the database clock: shift rows there. */
  async function shift(sql: string, params: unknown[] = []): Promise<void> {
    await queryRows(orm, sql, params);
  }

  async function seed(count: number): Promise<string[]> {
    const fixture = await createTenantFixture(orm);
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const result = await notifications.create(notificationInput(fixture));
      if (result.kind !== 'created') throw new Error('expected created');
      ids.push(await deliveryIdOf(orm, result.notificationId));
    }
    return ids;
  }

  it('claims available events with a lease and an incremented dispatch count', async () => {
    const [deliveryId] = await seed(1);

    const claimed = await outbox.claimAvailable(10, LEASE_MS);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      deliveryId,
      generation: 1,
      channel: 'email',
      dispatchCount: 1,
    });
    expect(await outbox.claimAvailable(10, LEASE_MS)).toEqual([]);
  });

  it('does not claim events before they are available (database clock)', async () => {
    await seed(1);
    await shift(`update outbox_events set available_at = now() + interval '1 minute'`);
    expect(await outbox.claimAvailable(10, LEASE_MS)).toEqual([]);
    await shift(`update outbox_events set available_at = now()`);
    expect(await outbox.claimAvailable(10, LEASE_MS)).toHaveLength(1);
  });

  it('gives concurrent claimers disjoint events', async () => {
    await seed(12);

    const batches = await Promise.all([
      outbox.claimAvailable(5, LEASE_MS),
      outbox.claimAvailable(5, LEASE_MS),
      outbox.claimAvailable(5, LEASE_MS),
    ]);

    const all = batches.flat().map((e) => e.id);
    expect(all).toHaveLength(12);
    expect(new Set(all).size).toBe(12);
  });

  it('marks published only with the current lease token', async () => {
    await seed(1);
    const [event] = await outbox.claimAvailable(1, LEASE_MS);
    if (!event) throw new Error('expected claim');

    expect(await outbox.markPublished(event.id, '00000000-0000-4000-8000-000000000000')).toBe(
      false,
    );
    expect(await outbox.markPublished(event.id, event.leaseToken)).toBe(true);
    expect(await outbox.markPublished(event.id, event.leaseToken)).toBe(false);
    const rows = await queryRows(
      orm,
      `select status, lease_token from outbox_events where id = ?`,
      [event.id],
    );
    expect(rows[0]).toEqual({ status: 'published', lease_token: null });
  });

  it('releases after a publish error and claims again later with a new dispatch sequence', async () => {
    await seed(1);
    const [event] = await outbox.claimAvailable(1, LEASE_MS);
    if (!event) throw new Error('expected claim');

    expect(await outbox.releaseAfterError(event.id, event.leaseToken, 'queue down', 60_000)).toBe(
      true,
    );
    const [released] = await queryRows(
      orm,
      `select extract(epoch from (available_at - now())) * 1000 as delay_ms
       from outbox_events where id = ?`,
      [event.id],
    );
    expect(Number(released?.delay_ms)).toBeGreaterThan(55_000);
    expect(await outbox.claimAvailable(1, LEASE_MS)).toEqual([]);
    await shift(`update outbox_events set available_at = now() where id = ?`, [event.id]);
    const [again] = await outbox.claimAvailable(1, LEASE_MS);
    expect(again).toMatchObject({ id: event.id, dispatchCount: 2 });
    expect(again?.leaseToken).not.toBe(event.leaseToken);
  });

  it('reclaims events whose publishing lease expired and fences the old dispatcher', async () => {
    await seed(1);
    const [first] = await outbox.claimAvailable(1, LEASE_MS);
    if (!first) throw new Error('expected claim');
    expect(await outbox.claimAvailable(1, LEASE_MS)).toEqual([]);
    await shift(`update outbox_events set lease_expires_at = now() - interval '1 second'`);

    const [second] = await outbox.claimAvailable(1, LEASE_MS);

    expect(second).toMatchObject({ id: first.id, dispatchCount: 2 });
    expect(await outbox.markPublished(first.id, first.leaseToken)).toBe(false);
    expect(await outbox.markPublished(first.id, second?.leaseToken ?? '')).toBe(true);
  });

  it('re-arms published events whose job was lost while the delivery is still runnable', async () => {
    const [lostDelivery, acceptedDelivery] = await seed(2);
    const claimed = await outbox.claimAvailable(10, LEASE_MS);
    for (const event of claimed) await outbox.markPublished(event.id, event.leaseToken);

    // The second delivery was processed and accepted: it must never be re-dispatched.
    const claim = await deliveries.claim(acceptedDelivery ?? '', 1, LEASE_MS);
    if (!claim) throw new Error('expected delivery claim');
    const started = await deliveries.startAttempt(claim, {
      attemptId: randomUUID(),
      attemptNumber: 1,
      providerInstanceId: claim.routing.providerInstanceIds[0] ?? '',
      providerInstanceRevision: 1,
      providerIdempotencyKey: 'k',
    });
    expect(started).toBe(true);
    const attempt = await queryRows(orm, `select id from delivery_attempts where delivery_id = ?`, [
      acceptedDelivery,
    ]);
    const resolved = await deliveries.resolveAttempt(claim, String(attempt[0]?.id), {
      outcome: 'accepted',
      externalReference: 'msg-1',
      receiptStatus: 'unavailable',
    });
    expect(resolved).toBe(true);

    expect(await outbox.findLostPublications(60_000, 10)).toEqual([]);
    await shift(`update outbox_events set published_at = now() - interval '2 minutes'`);
    const candidates = await outbox.findLostPublications(60_000, 10);
    expect(candidates).toEqual([
      {
        id: expect.any(String) as unknown,
        deliveryId: lostDelivery,
        channel: 'email',
        dispatchCount: 1,
      },
    ]);
    // A stale candidate (another dispatch count) is never re-armed.
    expect(
      await outbox.rearmPublications(candidates.map((c) => ({ ...c, dispatchCount: 7 }))),
    ).toBe(0);
    expect(await outbox.rearmPublications(candidates)).toBe(1);
    expect(await outbox.rearmPublications(candidates)).toBe(0);

    const [rearmed] = await outbox.claimAvailable(10, LEASE_MS);
    expect(rearmed).toMatchObject({ deliveryId: lostDelivery, generation: 1, dispatchCount: 2 });
  });

  it('does not re-arm a delivery whose next attempt is not due yet', async () => {
    const [deliveryId] = await seed(1);
    const [event] = await outbox.claimAvailable(1, LEASE_MS);
    if (!event) throw new Error('expected claim');
    await outbox.markPublished(event.id, event.leaseToken);
    await shift(`update outbox_events set published_at = now() - interval '2 minutes'`);
    await shift(
      `update deliveries set next_attempt_at = now() + interval '1 minute' where id = ?`,
      [deliveryId],
    );
    expect(await outbox.findLostPublications(60_000, 10)).toEqual([]);
  });

  it('does not re-arm events of a delivery holding an active lease', async () => {
    const [deliveryId] = await seed(1);
    const [event] = await outbox.claimAvailable(1, LEASE_MS);
    if (!event) throw new Error('expected claim');
    await outbox.markPublished(event.id, event.leaseToken);
    await shift(`update outbox_events set published_at = now() - interval '2 minutes'`);
    await deliveries.claim(deliveryId ?? '', 1, 600_000);

    expect(await outbox.findLostPublications(60_000, 10)).toEqual([]);
    expect(
      await outbox.rearmPublications([
        { id: event.id, deliveryId: deliveryId ?? '', channel: 'email', dispatchCount: 1 },
      ]),
    ).toBe(0);
  });
});
