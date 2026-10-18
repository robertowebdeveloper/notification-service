import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../../../src/application/delivery/ports.js';
import {
  ProcessProviderEvents,
  type ProviderEventOptions,
} from '../../../src/application/delivery/process-provider-events.js';
import type { NormalizedEventType } from '../../../src/contracts/provider-port.js';
import { closeOrm, migratedOrm, queryRows, truncateAll } from '../database/support.js';
import { Reconcile } from '../../../src/application/delivery/reconcile.js';
import {
  createDelivery,
  createDeliveryFixture,
  deliveryRow,
  dueJob,
  gate,
  FakeEmailAdapter,
  harness,
  IDEMPOTENT_WITH_RECEIPTS,
  latestJob,
  outboxRows,
  processDelivery,
  unknownResult,
  type DeliveryFixture,
  type Harness,
} from './support.js';

describe('provider events -> deterministic receipt reducer', () => {
  let orm: MikroORM;
  let adapter: FakeEmailAdapter;
  let h: Harness;
  let fixture: DeliveryFixture;
  let instanceId: number;

  beforeAll(async () => {
    orm = await migratedOrm();
  });

  beforeEach(async () => {
    await truncateAll(orm);
    adapter = new FakeEmailAdapter('fake-resend', IDEMPOTENT_WITH_RECEIPTS);
    h = harness(orm, [adapter]);
    fixture = await createDeliveryFixture(orm, [{ type: 'fake-resend' }]);
    instanceId = fixture.instanceIds[0] ?? 0;
  });

  afterAll(closeOrm);

  function events(options: Partial<ProviderEventOptions> = {}) {
    return new ProcessProviderEvents({
      events: h.repos.providerEvents,
      receipts: h.repos.receipts,
      suppressions: h.repos.suppressions,
      control: h.control,
      logger: silentLogger,
      options,
    });
  }

  async function acceptedDelivery(reference: string, email?: string): Promise<number> {
    adapter.queue(() => Promise.resolve({ outcome: 'accepted', externalReference: reference }));
    const deliveryId = await createDelivery(h.repos, orm, fixture, email ? { email } : {});
    expect(await processDelivery(h).execute(await latestJob(orm, deliveryId))).toBe('accepted');
    return deliveryId;
  }

  function record(
    type: NormalizedEventType,
    messageId: string,
    eventId: string = randomUUID(),
    at = new Date(),
  ) {
    return h.repos.providerEvents.record({
      tenantId: fixture.tenantId,
      providerInstanceId: instanceId,
      externalEventId: eventId,
      externalMessageId: messageId,
      type,
      occurredAt: at,
      receivedAt: new Date(),
      payload: {},
    });
  }

  async function unprocessedCount(): Promise<number> {
    const rows = await queryRows(
      orm,
      `select count(*)::int as n from provider_events where processed_at is null`,
    );
    return Number(rows[0]?.n);
  }

  it('out-of-order and duplicate events never downgrade a delivered receipt', async () => {
    const deliveryId = await acceptedDelivery('msg-1');
    expect((await deliveryRow(orm, deliveryId)).receipt_status).toBe('pending');

    const delivered = await record(
      'delivered',
      'msg-1',
      'evt-delivered',
      new Date(Date.now() - 1_000),
    );
    expect(delivered.kind).toBe('inserted');
    expect((await record('delivered', 'msg-1', 'evt-delivered')).kind).toBe('duplicate');
    await record('accepted', 'msg-1', 'evt-accepted', new Date(Date.now() - 5_000));
    await record('opened', 'msg-1');

    const report = await events().runOnce();
    expect(report.processed).toBe(3);
    expect(await deliveryRow(orm, deliveryId)).toMatchObject({
      submission_status: 'accepted',
      receipt_status: 'delivered',
    });
    expect(await unprocessedCount()).toBe(0);

    // A late accepted arriving after processing changes nothing either.
    await record('accepted', 'msg-1');
    await events().runOnce();
    expect((await deliveryRow(orm, deliveryId)).receipt_status).toBe('delivered');
  });

  it('hard bounce -> undeliverable + suppression, without any new send', async () => {
    const deliveryId = await acceptedDelivery('msg-bounce', 'Bounced@Example.TEST');
    await record('delivered', 'msg-bounce');
    await record('bounced_hard', 'msg-bounce');
    await events().runOnce();

    expect((await deliveryRow(orm, deliveryId)).receipt_status).toBe('undeliverable');
    expect(
      await h.repos.suppressions.isSuppressed(fixture.tenantId, 'email', 'Bounced@example.test'),
    ).toBe(true);
    expect(await outboxRows(orm, deliveryId)).toHaveLength(1);
    expect(adapter.sends).toHaveLength(1);

    // The suppression blocks the next delivery to the same mailbox.
    const next = await createDelivery(h.repos, orm, fixture, { email: 'Bounced@example.test' });
    expect(await processDelivery(h).execute(await latestJob(orm, next))).toBe('suppressed');
    expect(adapter.sends).toHaveLength(1);
  });

  it('complaints suppress the recipient but keep the receipt', async () => {
    const deliveryId = await acceptedDelivery('msg-complaint', 'complainer@example.test');
    await record('delivered', 'msg-complaint');
    await record('complained', 'msg-complaint');
    await events().runOnce();
    expect((await deliveryRow(orm, deliveryId)).receipt_status).toBe('delivered');
    const rows = await queryRows(
      orm,
      `select reason, source from suppressions where tenant_id = ?`,
      [fixture.tenantId],
    );
    expect(rows).toEqual([{ reason: 'complaint', source: 'provider_event' }]);
  });

  it('an event that precedes the external reference is kept and correlated later', async () => {
    await record('delivered', 'msg-early');
    const first = await events().runOnce();
    expect(first).toMatchObject({ correlated: 0, processed: 0, orphaned: 0 });
    expect(await unprocessedCount()).toBe(1);

    const deliveryId = await acceptedDelivery('msg-early');
    const second = await events().runOnce();
    expect(second).toMatchObject({ correlated: 1, processed: 1 });
    expect((await deliveryRow(orm, deliveryId)).receipt_status).toBe('delivered');
  });

  it('provider evidence resolves an unknown delivery as accepted (no re-send)', async () => {
    adapter.queue(unknownResult('msg-ambiguous'));
    const deliveryId = await createDelivery(h.repos, orm, fixture);
    expect(await processDelivery(h).execute(await latestJob(orm, deliveryId))).toBe('unknown');

    await record('delivered', 'msg-ambiguous');
    await events().runOnce();
    expect(await deliveryRow(orm, deliveryId)).toMatchObject({
      submission_status: 'accepted',
      receipt_status: 'delivered',
    });
    const attempts = await queryRows(
      orm,
      `select outcome from delivery_attempts where delivery_id = ?`,
      [deliveryId],
    );
    expect(attempts).toEqual([{ outcome: 'accepted' }]);
    expect(adapter.sends).toHaveLength(1);
  });

  it('evidence for a delivery waiting for a safe replay resolves it (no replay sent)', async () => {
    adapter.queue(unknownResult('msg-replay'));
    const deliveryId = await createDelivery(h.repos, orm, fixture);
    expect(await processDelivery(h).execute(await latestJob(orm, deliveryId))).toBe('unknown');
    const reconcile = new Reconcile({
      outbox: h.repos.outbox,
      deliveries: h.repos.deliveries,
      control: h.control,
      providerConfig: h.repos.providerConfig,
      receipts: h.repos.receipts,
      catalog: h.registry,
      secrets: { resolve: () => Promise.resolve(new Map()) },
      logger: silentLogger,
      random: () => 0,
      options: { unknownCheckIntervalMs: 0, replayDelayMs: 0 },
    });
    expect((await reconcile.runOnce()).replaysScheduled).toBe(1);
    expect(await deliveryRow(orm, deliveryId)).toMatchObject({
      submission_status: 'retry_wait',
      generation: 2,
    });

    await record('delivered', 'msg-replay');
    expect((await events().runOnce()).processed).toBe(1);
    expect(await deliveryRow(orm, deliveryId)).toMatchObject({
      submission_status: 'accepted',
      receipt_status: 'delivered',
    });
    const attempts = await queryRows(
      orm,
      `select generation, outcome from delivery_attempts where delivery_id = ?`,
      [deliveryId],
    );
    expect(attempts).toEqual([{ generation: 1, outcome: 'accepted' }]);
    expect(await processDelivery(h).execute(await dueJob(orm, deliveryId))).toBe('stale');
    expect(adapter.sends).toHaveLength(1);
  });

  it('keeps acceptance evidence for a delivery being sent until the attempt is recorded', async () => {
    const pending = gate();
    adapter.queue(pending.behaviour);
    const deliveryId = await createDelivery(h.repos, orm, fixture);
    const running = processDelivery(h).execute(await latestJob(orm, deliveryId));
    await pending.started;
    // Lets the webhook correlate to the in-flight attempt (as if its message id were known).
    await queryRows(
      orm,
      `update delivery_attempts set external_reference = 'msg-inflight' where delivery_id = ?`,
      [deliveryId],
    );
    await record('delivered', 'msg-inflight');
    expect((await events().runOnce()).processed).toBe(0);
    expect(await unprocessedCount()).toBe(1);

    pending.release({ outcome: 'unknown', reason: 'timeout_after_submission' });
    expect(await running).toBe('unknown');
    expect((await events().runOnce()).processed).toBe(1);
    expect(await deliveryRow(orm, deliveryId)).toMatchObject({
      submission_status: 'accepted',
      receipt_status: 'delivered',
    });
    expect(adapter.sends).toHaveLength(1);
  });

  it('a backlog of uncorrelated events larger than the batch never starves correlated ones', async () => {
    const old = new Date(Date.now() - 60_000);
    for (let i = 0; i < 5; i += 1) await record('delivered', `msg-never-${i}`, undefined, old);
    await queryRows(orm, `update provider_events set received_at = ?`, [old]);

    // Correlated on insert (the attempt already carries the reference).
    const deliveryId = await acceptedDelivery('msg-fresh');
    await record('delivered', 'msg-fresh');
    // Arrives before its attempt is committed: correlated later by correlatePending.
    await record('delivered', 'msg-late');
    const lateDelivery = await acceptedDelivery('msg-late', 'late@example.test');

    const report = await events({ batchSize: 2 }).runOnce();
    expect(report).toEqual({ correlated: 1, processed: 2, orphaned: 0 });
    expect((await deliveryRow(orm, deliveryId)).receipt_status).toBe('delivered');
    expect((await deliveryRow(orm, lateDelivery)).receipt_status).toBe('delivered');
    expect(await unprocessedCount()).toBe(5);

    // Orphan candidates are only the old, uncorrelated ones, bounded by the batch size.
    const cleanup = await events({ batchSize: 2, orphanAfterMs: 30_000 }).runOnce();
    expect(cleanup).toEqual({ correlated: 0, processed: 0, orphaned: 2 });
    expect(await unprocessedCount()).toBe(3);
  });

  it('closes events that never correlate as orphans', async () => {
    await record('delivered', 'msg-unknown-to-us');
    const report = await events({ orphanAfterMs: 0 }).runOnce();
    expect(report.orphaned).toBe(1);
    expect(await unprocessedCount()).toBe(0);
  });
});
