import type { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../../../src/application/delivery/ports.js';
import { Reconcile } from '../../../src/application/delivery/reconcile.js';
import type { DeliveryRepository } from '../../../src/application/ports/repositories.js';
import { closeOrm, migratedOrm, truncateAll } from '../database/support.js';
import {
  accept,
  AllowAllLimiter,
  attemptRows,
  createDelivery,
  createDeliveryFixture,
  deliveryRow,
  dueJob,
  FakeEmailAdapter,
  gate,
  hangUntilAborted,
  harness,
  IDEMPOTENT_WITH_RECEIPTS,
  InMemoryBreaker,
  latestJob,
  makeDue,
  outboxRows,
  processDelivery,
  reject,
  toTime,
  unknownResult,
  type DeliveryFixture,
  type Harness,
} from './support.js';

describe('ProcessDelivery (PostgreSQL + fake providers)', () => {
  let orm: MikroORM;
  let primary: FakeEmailAdapter;
  let secondary: FakeEmailAdapter;
  let h: Harness;
  let fixture: DeliveryFixture;

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
  });

  afterAll(closeOrm);

  function newDelivery(options: Parameters<typeof createDelivery>[3] = {}) {
    return createDelivery(h.repos, orm, fixture, options);
  }

  function reconcile(overrides: Partial<ConstructorParameters<typeof Reconcile>[0]> = {}) {
    return new Reconcile({
      outbox: h.repos.outbox,
      deliveries: h.repos.deliveries,
      control: h.control,
      providerConfig: h.repos.providerConfig,
      receipts: h.repos.receipts,
      catalog: h.registry,
      secrets: { resolve: () => Promise.resolve(new Map()) },
      logger: silentLogger,
      random: () => 0,
      options: { unknownCheckIntervalMs: 0, replayDelayMs: 0, lostPublicationAfterMs: 60_000 },
      ...overrides,
    });
  }

  it('happy path: accepted with receipt unavailable for an adapter without receipts', async () => {
    const deliveryId = await newDelivery();
    const outcome = await processDelivery(h).execute(await latestJob(orm, deliveryId));

    expect(outcome).toBe('accepted');
    const row = await deliveryRow(orm, deliveryId);
    expect(row).toMatchObject({
      submission_status: 'accepted',
      receipt_status: 'unavailable',
      attempts_used: 1,
      lease_token: null,
    });
    const attempts = await attemptRows(orm, deliveryId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      outcome: 'accepted',
      provider_instance_id: fixture.instanceIds[0],
    });
    expect(primary.sends).toHaveLength(1);
    expect(primary.sends[0]?.idempotencyKey).toBe(attempts[0]?.provider_idempotency_key);
    expect(primary.sends[0]?.idempotencyKey).toMatch(/^nsd1-[0-9a-f]{64}$/);
    expect(attempts[0]?.external_reference).toMatch(/^ext-/);
  });

  it('accepted by an adapter with receipts leaves the receipt pending', async () => {
    primary = new FakeEmailAdapter('fake-primary', IDEMPOTENT_WITH_RECEIPTS);
    h = harness(orm, [primary, secondary]);
    const deliveryId = await newDelivery();
    await processDelivery(h).execute(await latestJob(orm, deliveryId));
    expect(await deliveryRow(orm, deliveryId)).toMatchObject({
      submission_status: 'accepted',
      receipt_status: 'pending',
    });
  });

  it('retryable rejection -> retry_wait -> next generation -> accepted', async () => {
    primary.queue(reject('retryable'));
    const deliveryId = await newDelivery();
    const worker = processDelivery(h);
    const firstJob = await latestJob(orm, deliveryId);
    const before = Date.now();

    expect(await worker.execute(firstJob)).toBe('retry_scheduled');
    const waiting = await deliveryRow(orm, deliveryId);
    expect(waiting).toMatchObject({
      submission_status: 'retry_wait',
      generation: 2,
      attempts_used: 1,
    });
    const events = await outboxRows(orm, deliveryId);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ generation: 2, status: 'pending' });
    // random() = 0 -> no jitter: first retry 5 s after the failure.
    const delay = toTime(events[1]?.available_at) - before;
    expect(delay).toBeGreaterThanOrEqual(4_900);
    expect(delay).toBeLessThan(6_000);

    // The old job (generation 1) is obsolete and sends nothing.
    expect(await worker.execute(firstJob)).toBe('stale');
    // A job of the new generation arriving before the backoff elapsed cannot skip it.
    expect(await worker.execute(await latestJob(orm, deliveryId))).toBe('stale');
    expect(primary.sends).toHaveLength(1);
    expect(await worker.execute(await dueJob(orm, deliveryId))).toBe('accepted');

    const attempts = await attemptRows(orm, deliveryId);
    expect(attempts.map((a) => a.outcome)).toEqual(['rejected', 'accepted']);
    expect(attempts[0]?.provider_idempotency_key).not.toBe(attempts[1]?.provider_idempotency_key);
    expect(primary.sends).toHaveLength(2);
    expect(secondary.sends).toHaveLength(0);
  });

  it('honours Retry-After on retryable rejections', async () => {
    primary.queue(reject('retryable', { retryAfterMs: 120_000 }));
    const deliveryId = await newDelivery();
    const before = Date.now();
    await processDelivery(h).execute(await latestJob(orm, deliveryId));
    const events = await outboxRows(orm, deliveryId);
    expect(toTime(events[1]?.available_at) - before).toBeGreaterThanOrEqual(119_900);
  });

  it('fails with attempts_exhausted when the budget is used', async () => {
    primary.queue(reject('retryable'), reject('retryable'));
    const deliveryId = await newDelivery({ maxAttempts: 2 });
    const worker = processDelivery(h);
    expect(await worker.execute(await latestJob(orm, deliveryId))).toBe('retry_scheduled');
    expect(await worker.execute(await dueJob(orm, deliveryId))).toBe('failed');
    expect(await deliveryRow(orm, deliveryId)).toMatchObject({
      submission_status: 'failed',
      terminal_reason: 'attempts_exhausted',
      attempts_used: 2,
    });
    expect(await outboxRows(orm, deliveryId)).toHaveLength(2);
  });

  it('permanent rejection -> failed, no retry and no fallback', async () => {
    primary.queue(reject('permanent', { code: 'recipient_rejected' }));
    const deliveryId = await newDelivery();
    expect(await processDelivery(h).execute(await latestJob(orm, deliveryId))).toBe('failed');
    expect(await deliveryRow(orm, deliveryId)).toMatchObject({
      submission_status: 'failed',
      terminal_reason: 'recipient_rejected',
    });
    expect(await outboxRows(orm, deliveryId)).toHaveLength(1);
    expect(secondary.sends).toHaveLength(0);
  });

  it('ambiguous timeout -> unknown, no fallback, never re-sent (provider without idempotency)', async () => {
    primary.queue(hangUntilAborted);
    const deliveryId = await newDelivery();
    const worker = processDelivery(h, { options: { sendTimeoutMs: 200 } });
    const job = await latestJob(orm, deliveryId);

    expect(await worker.execute(job)).toBe('unknown');
    expect(await deliveryRow(orm, deliveryId)).toMatchObject({
      submission_status: 'unknown',
      terminal_reason: 'ambiguous_provider_result',
    });
    expect((await attemptRows(orm, deliveryId))[0]).toMatchObject({ outcome: 'unknown' });

    expect(await worker.execute(job)).toBe('stale');
    const report = await reconcile().runOnce();
    expect(report).toMatchObject({ unknownChecked: 1, replaysScheduled: 0, unknownAccepted: 0 });
    expect((await deliveryRow(orm, deliveryId)).submission_status).toBe('unknown');
    expect(primary.sends).toHaveLength(1);
    expect(secondary.sends).toHaveLength(0);
  });

  it('configuration error -> alarm, quarantine and fallback to the second provider', async () => {
    primary.queue(reject('configuration', { code: 'authentication_failed' }));
    const breaker = new InMemoryBreaker();
    const deliveryId = await newDelivery();
    const worker = processDelivery(h, { breaker });

    expect(await worker.execute(await latestJob(orm, deliveryId))).toBe('fallback_scheduled');
    const waiting = await deliveryRow(orm, deliveryId);
    expect(waiting).toMatchObject({ submission_status: 'retry_wait', generation: 2 });
    const events = await outboxRows(orm, deliveryId);
    expect(toTime(events[1]?.available_at)).toBeLessThanOrEqual(Date.now());
    expect(breaker.forced).toEqual([{ id: fixture.instanceIds[0], durationMs: 300_000 }]);

    // Even with the breaker reset, the delivery history excludes the misconfigured instance.
    breaker.open.clear();
    expect(await worker.execute(await dueJob(orm, deliveryId))).toBe('accepted');
    const attempts = await attemptRows(orm, deliveryId);
    expect(attempts.map((a) => [a.provider_instance_id, a.outcome])).toEqual([
      [fixture.instanceIds[0], 'rejected'],
      [fixture.instanceIds[1], 'accepted'],
    ]);
    expect(secondary.sends).toHaveLength(1);
  });

  it('configuration error without another provider -> failed', async () => {
    primary.queue(reject('configuration'));
    const deliveryId = await newDelivery({ instanceIds: [fixture.instanceIds[0] ?? ''] });
    expect(await processDelivery(h).execute(await latestJob(orm, deliveryId))).toBe('failed');
  });

  it('does not fall back when the policy disables fallback', async () => {
    primary.queue(reject('configuration'));
    const deliveryId = await newDelivery({ fallbackEnabled: false });
    expect(await processDelivery(h).execute(await latestJob(orm, deliveryId))).toBe('failed');
    expect(secondary.sends).toHaveLength(0);
  });

  it('duplicate jobs for a resolved delivery do nothing', async () => {
    const deliveryId = await newDelivery();
    const worker = processDelivery(h);
    const job = await latestJob(orm, deliveryId);
    expect(await worker.execute(job)).toBe('accepted');
    expect(await worker.execute(job)).toBe('stale');
    expect(await worker.execute({ ...job, outboxEventId: 'other' })).toBe('stale');
    expect(primary.sends).toHaveLength(1);
    expect(await attemptRows(orm, deliveryId)).toHaveLength(1);
  });

  it('two concurrent workers on the same delivery produce a single send', async () => {
    primary.queue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { outcome: 'accepted' };
    });
    const deliveryId = await newDelivery();
    const job = await latestJob(orm, deliveryId);
    const outcomes = await Promise.all([
      processDelivery(h).execute(job),
      processDelivery(h).execute(job),
    ]);
    expect(outcomes.sort()).toEqual(['accepted', 'stale']);
    expect(primary.sends).toHaveLength(1);
    expect(await attemptRows(orm, deliveryId)).toHaveLength(1);
  });

  it('a worker whose lease expired cannot overwrite the newer state, nor trigger a second send', async () => {
    const pending = gate();
    primary.queue(pending.behaviour);
    const deliveryId = await newDelivery();
    const job = await latestJob(orm, deliveryId);
    const slow = processDelivery(h, { options: { leaseMs: 300, leaseRenewIntervalMs: 0 } });

    const running = slow.execute(job);
    await pending.started;
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await h.repos.deliveries.markStaleSendingUnknown(10)).toBe(1);
    // An expired lease does not authorize another worker to send.
    expect(await processDelivery(h).execute(job)).toBe('stale');

    pending.release({ outcome: 'accepted', externalReference: 'late' });
    expect(await running).toBe('fenced');
    expect(await deliveryRow(orm, deliveryId)).toMatchObject({
      submission_status: 'unknown',
      terminal_reason: 'lease_expired_while_sending',
    });
    expect(primary.sends).toHaveLength(1);
  });

  it('renews the lease while the provider call is in flight', async () => {
    primary.queue(async () => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      return { outcome: 'accepted' };
    });
    const deliveryId = await newDelivery();
    const worker = processDelivery(h, { options: { leaseMs: 300, leaseRenewIntervalMs: 100 } });
    const running = worker.execute(await latestJob(orm, deliveryId));
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await h.repos.deliveries.markStaleSendingUnknown(10)).toBe(0);
    expect(await running).toBe('accepted');
  });

  it('expired deliveries are closed without sending', async () => {
    const deliveryId = await newDelivery({ expiresAt: new Date(Date.now() - 1_000) });
    expect(await processDelivery(h).execute(await latestJob(orm, deliveryId))).toBe('expired');
    expect(await deliveryRow(orm, deliveryId)).toMatchObject({
      submission_status: 'expired',
      terminal_reason: 'delivery_expired',
      attempts_used: 0,
    });
    expect(primary.sends).toHaveLength(0);
  });

  it('suppressed recipients are not sent (domain case-insensitive, local part preserved)', async () => {
    await h.repos.suppressions.add({
      tenantId: fixture.tenantId,
      channel: 'email',
      recipientKey: 'Blocked.User@example.test',
      reason: 'hard_bounce',
      source: 'admin',
      providerEventId: null,
    });
    const blocked = await newDelivery({ email: ' Blocked.User@EXAMPLE.Test' });
    const differentLocal = await newDelivery({ email: 'blocked.user@example.test' });
    const worker = processDelivery(h);
    expect(await worker.execute(await latestJob(orm, blocked))).toBe('suppressed');
    expect(await worker.execute(await latestJob(orm, differentLocal))).toBe('accepted');
    expect(await deliveryRow(orm, blocked)).toMatchObject({
      submission_status: 'suppressed',
      terminal_reason: 'recipient_suppressed',
    });
    expect(primary.sends).toHaveLength(1);
  });

  it('rate limiter without capacity reschedules without consuming attempts', async () => {
    const deliveryId = await newDelivery();
    const limited = processDelivery(h, {
      rateLimiter: { tryAcquire: () => Promise.resolve({ allowed: false, retryAfterMs: 2_000 }) },
    });
    const job = await latestJob(orm, deliveryId);
    const before = Date.now();
    expect(await limited.execute(job)).toBe('deferred');

    const row = await deliveryRow(orm, deliveryId);
    expect(row).toMatchObject({
      submission_status: 'pending',
      attempts_used: 0,
      lease_token: null,
      generation: 1,
    });
    const [event] = await outboxRows(orm, deliveryId);
    expect(event).toMatchObject({ status: 'pending', generation: 1 });
    expect(toTime(event?.available_at) - before).toBeGreaterThanOrEqual(1_900);
    expect(primary.sends).toHaveLength(0);

    // A duplicate job of the same generation cannot skip the deferral.
    expect(await processDelivery(h).execute(job)).toBe('stale');
    // Same generation is claimable again once the deferral elapsed.
    await makeDue(orm, deliveryId);
    expect(await processDelivery(h).execute(job)).toBe('accepted');
    expect((await deliveryRow(orm, deliveryId)).attempts_used).toBe(1);
  });

  it('applies the per-instance limits of the selected provider, defaults otherwise', async () => {
    const [primaryId, secondaryId] = fixture.instanceIds;
    await orm.em.fork().execute(`update provider_instances set limits = ?::jsonb where id = ?`, [
      JSON.stringify({
        sendRateLimit: { burst: 2, perSecond: 0.5 },
        circuitBreaker: { failureThreshold: 1, openMs: 5_000 },
      }),
      primaryId,
    ]);
    const limits: { id: string; limit: unknown }[] = [];
    const failures: { id: string; settings: unknown }[] = [];
    const breaker = new InMemoryBreaker();
    const worker = processDelivery(h, {
      rateLimiter: {
        tryAcquire: (id, limit) => {
          limits.push({ id, limit });
          return Promise.resolve({ allowed: true });
        },
      },
      breaker: Object.assign(breaker, {
        recordFailure: (id: string, settings?: unknown) => {
          failures.push({ id, settings });
          return Promise.resolve();
        },
      }),
    });
    primary.queue(reject('retryable'));
    const deliveryId = await newDelivery();
    expect(await worker.execute(await latestJob(orm, deliveryId))).toBe('retry_scheduled');
    const viaSecondary = await newDelivery({ instanceIds: [secondaryId ?? ''] });
    expect(await worker.execute(await latestJob(orm, viaSecondary))).toBe('accepted');

    expect(limits).toEqual([
      { id: primaryId, limit: { burst: 2, perSecond: 0.5 } },
      { id: secondaryId, limit: undefined },
    ]);
    expect(failures).toEqual([{ id: primaryId, settings: { failureThreshold: 1, openMs: 5_000 } }]);
  });

  it('suspends sending when the rate limiter or the breaker is unavailable', async () => {
    const deliveryId = await newDelivery();
    const job = await latestJob(orm, deliveryId);
    const limiterDown = processDelivery(h, {
      rateLimiter: { tryAcquire: () => Promise.reject(new Error('valkey down')) },
    });
    expect(await limiterDown.execute(job)).toBe('deferred');
    await makeDue(orm, deliveryId);

    const breakerDown = new InMemoryBreaker();
    breakerDown.acquire = () => Promise.reject(new Error('valkey down'));
    expect(await processDelivery(h, { breaker: breakerDown }).execute(job)).toBe('deferred');

    expect(primary.sends).toHaveLength(0);
    expect(secondary.sends).toHaveLength(0);
    expect(await deliveryRow(orm, deliveryId)).toMatchObject({
      submission_status: 'pending',
      attempts_used: 0,
    });
  });

  it('kill switch and open breaker skip an instance; none usable defers', async () => {
    await orm.em
      .fork()
      .execute(`update provider_instances set enabled = false where id = ?`, [
        fixture.instanceIds[0],
      ]);
    const first = await newDelivery();
    expect(await processDelivery(h).execute(await latestJob(orm, first))).toBe('accepted');
    expect(secondary.sends).toHaveLength(1);

    const breaker = new InMemoryBreaker();
    breaker.open.set(fixture.instanceIds[1] ?? '', Date.now() + 60_000);
    const second = await newDelivery();
    expect(await processDelivery(h, { breaker }).execute(await latestJob(orm, second))).toBe(
      'deferred',
    );
    expect(await deliveryRow(orm, second)).toMatchObject({
      submission_status: 'pending',
      attempts_used: 0,
    });
  });

  it('unknown on an idempotent provider -> safe replay with the same provider and key', async () => {
    primary = new FakeEmailAdapter('fake-primary', IDEMPOTENT_WITH_RECEIPTS);
    primary.queue(unknownResult());
    h = harness(orm, [primary, secondary]);
    const deliveryId = await newDelivery();
    const worker = processDelivery(h);

    expect(await worker.execute(await latestJob(orm, deliveryId))).toBe('unknown');
    const report = await reconcile().runOnce();
    expect(report.replaysScheduled).toBe(1);
    expect(await deliveryRow(orm, deliveryId)).toMatchObject({
      submission_status: 'retry_wait',
      generation: 2,
    });

    expect(await worker.execute(await dueJob(orm, deliveryId))).toBe('accepted');
    expect(primary.sends).toHaveLength(2);
    expect(primary.sends[1]?.idempotencyKey).toBe(primary.sends[0]?.idempotencyKey);
    expect(secondary.sends).toHaveLength(0);
    const attempts = await attemptRows(orm, deliveryId);
    expect(attempts.map((a) => a.outcome)).toEqual(['unknown', 'accepted']);
  });

  it('a rejection during a safe replay stays unknown (never a fresh, non-idempotent send)', async () => {
    primary = new FakeEmailAdapter('fake-primary', IDEMPOTENT_WITH_RECEIPTS);
    primary.queue(unknownResult(), reject('configuration'));
    h = harness(orm, [primary, secondary]);
    const deliveryId = await newDelivery();
    const worker = processDelivery(h);
    await worker.execute(await latestJob(orm, deliveryId));
    await reconcile().runOnce();
    expect(await worker.execute(await dueJob(orm, deliveryId))).toBe('unknown');
    expect(secondary.sends).toHaveLength(0);
  });

  it('a safe replay past the idempotency window returns to unknown without sending', async () => {
    primary = new FakeEmailAdapter('fake-primary', IDEMPOTENT_WITH_RECEIPTS);
    primary.queue(unknownResult());
    h = harness(orm, [primary, secondary]);
    const deliveryId = await newDelivery({ expiresAt: new Date(Date.now() + 72 * 3600_000) });
    await processDelivery(h).execute(await latestJob(orm, deliveryId));
    await reconcile().runOnce();

    const late = processDelivery(h, { clock: () => new Date(Date.now() + 23.5 * 3600_000) });
    expect(await late.execute(await dueJob(orm, deliveryId))).toBe('returned_to_unknown');
    expect((await deliveryRow(orm, deliveryId)).submission_status).toBe('unknown');
    expect(primary.sends).toHaveLength(1);

    // Provider evidence later resolves the ambiguous attempt of the older generation too.
    expect((await deliveryRow(orm, deliveryId)).generation).toBe(2);
    expect(
      await h.control.resolveUnknownAccepted(fixture.tenantId, deliveryId, null, 'pending', null),
    ).toBe(true);
    expect((await deliveryRow(orm, deliveryId)).submission_status).toBe('accepted');
    expect((await attemptRows(orm, deliveryId)).map((a) => [a.generation, a.outcome])).toEqual([
      [1, 'accepted'],
    ]);
  });

  describe('a scheduled safe replay never turns an ambiguous send into a terminal state', () => {
    async function replayScheduled(): Promise<string> {
      primary = new FakeEmailAdapter('fake-primary', IDEMPOTENT_WITH_RECEIPTS);
      primary.queue(unknownResult());
      h = harness(orm, [primary, secondary]);
      const deliveryId = await newDelivery();
      expect(await processDelivery(h).execute(await latestJob(orm, deliveryId))).toBe('unknown');
      expect((await reconcile().runOnce()).replaysScheduled).toBe(1);
      return deliveryId;
    }

    it('expiry passed before the replay ran -> back to unknown, not expired', async () => {
      const deliveryId = await replayScheduled();
      await orm.em
        .fork()
        .execute(`update deliveries set expires_at = now() - interval '1 second' where id = ?`, [
          deliveryId,
        ]);
      expect(await processDelivery(h).execute(await dueJob(orm, deliveryId))).toBe(
        'returned_to_unknown',
      );
      expect(await deliveryRow(orm, deliveryId)).toMatchObject({
        submission_status: 'unknown',
        terminal_reason: 'replay_expired',
        lease_token: null,
      });
      expect(primary.sends).toHaveLength(1);
    });

    it('suppression added before the replay ran -> back to unknown, not suppressed', async () => {
      const deliveryId = await replayScheduled();
      await h.repos.suppressions.add({
        tenantId: fixture.tenantId,
        channel: 'email',
        recipientKey: 'recipient@example.test',
        reason: 'complaint',
        source: 'admin',
        providerEventId: null,
      });
      expect(await processDelivery(h).execute(await dueJob(orm, deliveryId))).toBe(
        'returned_to_unknown',
      );
      expect(await deliveryRow(orm, deliveryId)).toMatchObject({
        submission_status: 'unknown',
        terminal_reason: 'replay_suppressed',
      });
      expect(primary.sends).toHaveLength(1);
    });

    it('acceptance evidence while the replay waits resolves it and fences the replay worker', async () => {
      const deliveryId = await replayScheduled();
      await makeDue(orm, deliveryId);
      // A worker claimed the replay job, then the evidence arrives before it starts sending.
      const claim = await h.repos.deliveries.claim(deliveryId, 2, 60_000);
      if (claim === null) throw new Error('expected claim');
      expect(
        await h.control.resolveUnknownAccepted(
          fixture.tenantId,
          deliveryId,
          null,
          'pending',
          'ext-evidence',
        ),
      ).toBe(true);
      expect(
        await h.repos.deliveries.startAttempt(claim, {
          attemptId: '00000000-0000-4000-8000-000000000001',
          attemptNumber: 2,
          providerInstanceId: fixture.instanceIds[0] ?? '',
          providerInstanceRevision: 1,
          providerIdempotencyKey: 'k',
        }),
      ).toBe(false);
      expect(await deliveryRow(orm, deliveryId)).toMatchObject({
        submission_status: 'accepted',
        lease_token: null,
      });
      expect(
        (await attemptRows(orm, deliveryId)).map((a) => [a.outcome, a.external_reference]),
      ).toEqual([['accepted', 'ext-evidence']]);
      expect(await processDelivery(h).execute(await latestJob(orm, deliveryId))).toBe('stale');
      expect(primary.sends).toHaveLength(1);
    });
  });

  /** The real repository with some methods replaced (fault injection). */
  function withOverrides(overrides: Partial<DeliveryRepository>): DeliveryRepository {
    const real = h.repos.deliveries;
    return {
      claim: (...args) => real.claim(...args),
      renewLease: (...args) => real.renewLease(...args),
      startAttempt: (...args) => real.startAttempt(...args),
      resolveAttempt: (...args) => real.resolveAttempt(...args),
      markTerminal: (...args) => real.markTerminal(...args),
      markStaleSendingUnknown: (...args) => real.markStaleSendingUnknown(...args),
      ...overrides,
    };
  }

  describe('recording the provider outcome', () => {
    function flakyResolve(
      mode: 'throw_before' | 'throw_after_commit',
      failures: number,
    ): { deliveries: DeliveryRepository; calls: () => number } {
      const real = h.repos.deliveries;
      let calls = 0;
      let left = failures;
      const deliveries = withOverrides({
        resolveAttempt: async (...args) => {
          calls += 1;
          if (left > 0) {
            left -= 1;
            if (mode === 'throw_after_commit') await real.resolveAttempt(...args);
            throw new Error('connection terminated unexpectedly');
          }
          return real.resolveAttempt(...args);
        },
      });
      return { deliveries, calls: () => calls };
    }

    const fastRetry = { resolveRetryBaseDelayMs: 20, resolveRetryMaxDelayMs: 50 };

    it('retries a transient database error after an accepted send', async () => {
      const deliveryId = await newDelivery();
      const flaky = flakyResolve('throw_before', 2);
      const worker = processDelivery(h, { deliveries: flaky.deliveries, options: fastRetry });
      expect(await worker.execute(await latestJob(orm, deliveryId))).toBe('accepted');
      expect(flaky.calls()).toBe(3);
      expect((await deliveryRow(orm, deliveryId)).submission_status).toBe('accepted');
      expect(primary.sends).toHaveLength(1);
    });

    it('recognises an outcome committed by a try whose answer was lost', async () => {
      const deliveryId = await newDelivery();
      const flaky = flakyResolve('throw_after_commit', 1);
      const worker = processDelivery(h, { deliveries: flaky.deliveries, options: fastRetry });
      expect(await worker.execute(await latestJob(orm, deliveryId))).toBe('accepted');
      expect(flaky.calls()).toBe(2);
      expect((await deliveryRow(orm, deliveryId)).submission_status).toBe('accepted');
    });

    it('never retries a fenced resolution', async () => {
      const deliveryId = await newDelivery();
      let calls = 0;
      const deliveries = withOverrides({
        resolveAttempt: () => {
          calls += 1;
          return Promise.resolve(false);
        },
      });
      const worker = processDelivery(h, { deliveries, options: fastRetry });
      expect(await worker.execute(await latestJob(orm, deliveryId))).toBe('fenced');
      expect(calls).toBe(1);
    });

    it('gives up when the lease could expire (the reconciler then moves it to unknown)', async () => {
      const deliveryId = await newDelivery();
      const flaky = flakyResolve('throw_before', 1_000);
      const worker = processDelivery(h, {
        deliveries: flaky.deliveries,
        options: { leaseMs: 1_500, leaseRenewIntervalMs: 0, ...fastRetry },
      });
      await expect(worker.execute(await latestJob(orm, deliveryId))).rejects.toThrow(
        /connection terminated/,
      );
      expect(flaky.calls()).toBeGreaterThan(1);
      expect((await deliveryRow(orm, deliveryId)).submission_status).toBe('sending');
    });
  });

  describe('half-open circuit breaker probe', () => {
    it('is given back when the delivery is deferred before sending', async () => {
      const breaker = new InMemoryBreaker();
      breaker.probeToken = 'probe-1';
      const deliveryId = await newDelivery();
      const worker = processDelivery(h, {
        breaker,
        rateLimiter: { tryAcquire: () => Promise.resolve({ allowed: false, retryAfterMs: 500 }) },
      });
      expect(await worker.execute(await latestJob(orm, deliveryId))).toBe('deferred');
      expect(breaker.released).toEqual([{ id: fixture.instanceIds[0], probeToken: 'probe-1' }]);
      expect(primary.sends).toHaveLength(0);
    });

    it('is given back when the attempt start is fenced', async () => {
      const breaker = new InMemoryBreaker();
      breaker.probeToken = 'probe-2';
      const deliveryId = await newDelivery();
      const deliveries = withOverrides({ startAttempt: () => Promise.resolve(false) });
      const worker = processDelivery(h, { breaker, deliveries });
      expect(await worker.execute(await latestJob(orm, deliveryId))).toBe('fenced');
      expect(breaker.released).toEqual([{ id: fixture.instanceIds[0], probeToken: 'probe-2' }]);
    });

    it('reports the outcome with the probe token, and a permanent rejection as success', async () => {
      const breaker = new InMemoryBreaker();
      breaker.probeToken = 'probe-3';
      primary.queue(reject('permanent', { code: 'recipient_rejected' }));
      const deliveryId = await newDelivery();
      expect(await processDelivery(h, { breaker }).execute(await latestJob(orm, deliveryId))).toBe(
        'failed',
      );
      expect(breaker.successes).toEqual([{ id: fixture.instanceIds[0], probeToken: 'probe-3' }]);
      expect(breaker.released).toEqual([]);
      expect(breaker.failures.size).toBe(0);
    });
  });

  it('reconciliation resolves unknown through the provider status query', async () => {
    primary = new FakeEmailAdapter('fake-primary', IDEMPOTENT_WITH_RECEIPTS);
    primary.queue(unknownResult('ext-known'));
    primary.statusResult = (reference) =>
      Promise.resolve(
        reference === 'ext-known'
          ? { found: true, accepted: true, receipt: 'delivered' }
          : { found: false },
      );
    h = harness(orm, [primary, secondary]);
    const deliveryId = await newDelivery();
    await processDelivery(h).execute(await latestJob(orm, deliveryId));

    const report = await reconcile().runOnce();
    expect(report).toMatchObject({ unknownAccepted: 1, replaysScheduled: 0 });
    expect(await deliveryRow(orm, deliveryId)).toMatchObject({
      submission_status: 'accepted',
      receipt_status: 'delivered',
    });
    expect((await attemptRows(orm, deliveryId))[0]).toMatchObject({ outcome: 'accepted' });
    expect(primary.sends).toHaveLength(1);
  });

  it('adapter exceptions are treated as ambiguous', async () => {
    primary.queue(() => Promise.reject(new Error('boom')));
    const deliveryId = await newDelivery();
    expect(await processDelivery(h).execute(await latestJob(orm, deliveryId))).toBe('unknown');
    expect(secondary.sends).toHaveLength(0);
  });

  it('uses the limiter once per send attempt', async () => {
    const limiter = new AllowAllLimiter();
    const deliveryId = await newDelivery();
    await processDelivery(h, { rateLimiter: limiter }).execute(await latestJob(orm, deliveryId));
    expect(limiter.calls).toBe(1);
    expect(accept).toBeTypeOf('function');
  });
});
