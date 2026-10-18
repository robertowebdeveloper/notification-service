import type { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../../../src/application/delivery/ports.js';
import { Reconcile } from '../../../src/application/delivery/reconcile.js';
import { closeOrm, migratedOrm, truncateAll } from '../database/support.js';
import { RecordingMetrics } from '../../unit/observability/recording-metrics.js';
import {
  createDelivery,
  createDeliveryFixture,
  dueJob,
  FakeEmailAdapter,
  gate,
  harness,
  IDEMPOTENT_WITH_RECEIPTS,
  latestJob,
  processDelivery,
  reject,
  unknownResult,
  type DeliveryFixture,
  type Harness,
} from './support.js';

describe('delivery pipeline metrics (PostgreSQL + fake providers)', () => {
  let orm: MikroORM;
  let primary: FakeEmailAdapter;
  let secondary: FakeEmailAdapter;
  let h: Harness;
  let fixture: DeliveryFixture;
  let metrics: RecordingMetrics;

  beforeAll(async () => {
    orm = await migratedOrm();
  });

  beforeEach(async () => {
    await truncateAll(orm);
    primary = new FakeEmailAdapter('fake-primary');
    secondary = new FakeEmailAdapter('fake-secondary');
    h = harness(orm, [primary, secondary]);
    fixture = await createDeliveryFixture(orm, [
      { type: 'fake-primary' },
      { type: 'fake-secondary' },
    ]);
    metrics = new RecordingMetrics();
  });

  afterAll(closeOrm);

  const newDelivery = (options: Parameters<typeof createDelivery>[3] = {}) =>
    createDelivery(h.repos, orm, fixture, options);
  const worker = (overrides: Parameters<typeof processDelivery>[1] = {}) =>
    processDelivery(h, { metrics, ...overrides });
  const reconcile = () =>
    new Reconcile({
      outbox: h.repos.outbox,
      deliveries: h.repos.deliveries,
      control: h.control,
      providerConfig: h.repos.providerConfig,
      receipts: h.repos.receipts,
      catalog: h.registry,
      secrets: { resolve: () => Promise.resolve(new Map()) },
      logger: silentLogger,
      metrics,
      random: () => 0,
      options: { unknownCheckIntervalMs: 0, replayDelayMs: 0, lostPublicationAfterMs: 60_000 },
    });

  it('accepted: time to first attempt, provider call and final outcome', async () => {
    const deliveryId = await newDelivery();
    expect(await worker().execute(await latestJob(orm, deliveryId))).toBe('accepted');

    const [ttfa] = metrics.of('observeTimeToFirstAttempt');
    expect(ttfa?.[0]).toBe('email');
    expect(ttfa?.[1]).toBeGreaterThanOrEqual(0);
    expect(ttfa?.[1]).toBeLessThan(30);
    const [call] = metrics.of('observeProviderCall');
    expect(call?.slice(0, 2)).toEqual(['fake-primary', 'accepted']);
    expect(call?.[2]).toBeGreaterThanOrEqual(0);
    expect(metrics.of('finalOutcome')).toEqual([['email', 'accepted']]);
  });

  it('retryable rejection: retry scheduled, first-attempt time observed only once', async () => {
    primary.queue(reject('retryable'));
    const deliveryId = await newDelivery();
    const w = worker();
    expect(await w.execute(await latestJob(orm, deliveryId))).toBe('retry_scheduled');
    expect(await w.execute(await dueJob(orm, deliveryId))).toBe('accepted');

    expect(metrics.of('retryScheduled')).toEqual([['email', 'fake-primary']]);
    expect(metrics.of('observeTimeToFirstAttempt')).toHaveLength(1);
    expect(metrics.of('observeProviderCall').map((c) => c[1])).toEqual(['rejected', 'accepted']);
    expect(metrics.of('finalOutcome')).toEqual([['email', 'accepted']]);
  });

  it('configuration error: fallback taken from the failing provider type', async () => {
    primary.queue(reject('configuration', { code: 'authentication_failed' }));
    const deliveryId = await newDelivery();
    expect(await worker().execute(await latestJob(orm, deliveryId))).toBe('fallback_scheduled');
    expect(metrics.of('fallbackTaken')).toEqual([['email', 'fake-primary']]);
    expect(metrics.of('retryScheduled')).toEqual([]);
  });

  it('permanent rejection and expiry are final outcomes', async () => {
    primary.queue(reject('permanent', { code: 'recipient_rejected' }));
    const rejected = await newDelivery();
    const expired = await newDelivery({ expiresAt: new Date(Date.now() - 1_000) });
    expect(await worker().execute(await latestJob(orm, rejected))).toBe('failed');
    expect(await worker().execute(await latestJob(orm, expired))).toBe('expired');

    expect(metrics.of('finalOutcome')).toEqual([
      ['email', 'failed'],
      ['email', 'expired'],
    ]);
    // Expired deliveries never reach the provider.
    expect(metrics.of('observeProviderCall')).toHaveLength(1);
  });

  it('ambiguous result: unknown transition, no final outcome', async () => {
    primary.queue(unknownResult());
    const deliveryId = await newDelivery();
    expect(await worker().execute(await latestJob(orm, deliveryId))).toBe('unknown');
    expect(metrics.of('unknownTransition')).toEqual([['ambiguous_result']]);
    expect(metrics.of('finalOutcome')).toEqual([]);
  });

  it('fenced resolution records the provider call but no transition', async () => {
    const pending = gate();
    primary.queue(pending.behaviour);
    const deliveryId = await newDelivery();
    const slow = worker({ options: { leaseMs: 300, leaseRenewIntervalMs: 0 } });
    const running = slow.execute(await latestJob(orm, deliveryId));
    await pending.started;
    await new Promise((resolve) => setTimeout(resolve, 400));

    const report = await reconcile().runOnce();
    expect(report.staleToUnknown).toBe(1);
    pending.release({ outcome: 'accepted', externalReference: 'late' });
    expect(await running).toBe('fenced');

    expect(metrics.of('observeProviderCall').map((c) => c[1])).toEqual(['accepted']);
    expect(metrics.of('finalOutcome')).toEqual([]);
    expect(metrics.of('unknownTransition')).toEqual([['stale_lease', 1]]);
    expect(metrics.of('reconciliation')).toContainEqual(['stale_to_unknown', 1]);
  });

  it('reconciliation: unknown resolved by status query counts as accepted', async () => {
    primary = new FakeEmailAdapter('fake-primary', IDEMPOTENT_WITH_RECEIPTS);
    primary.queue(unknownResult('ext-known'));
    primary.statusResult = () =>
      Promise.resolve({ found: true, accepted: true, receipt: 'delivered' });
    h = harness(orm, [primary, secondary]);
    const deliveryId = await newDelivery();
    await worker().execute(await latestJob(orm, deliveryId));
    metrics.calls.length = 0;

    await reconcile().runOnce();

    expect(metrics.of('finalOutcome')).toEqual([['email', 'accepted']]);
    expect(metrics.of('reconciliation')).toEqual(
      expect.arrayContaining([
        ['unknown_checked', 1],
        ['unknown_accepted', 1],
        ['replay_scheduled', 0],
      ]),
    );
  });
});
