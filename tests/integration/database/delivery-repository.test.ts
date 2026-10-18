import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AttemptStart, ClaimedDelivery } from '../../../src/application/ports/repositories.js';
import { PgDeliveryRepository } from '../../../src/infrastructure/database/delivery-repository.js';
import { PgNotificationRepository } from '../../../src/infrastructure/database/notification-repository.js';
import { toDate } from '../../../src/infrastructure/database/sql-support.js';
import {
  closeOrm,
  createTenantFixture,
  deliveryIdOf,
  migratedOrm,
  notificationInput,
  queryRows,
  truncateAll,
  type TenantFixture,
} from './support.js';

const LEASE_MS = 60_000;
const retryableError = {
  kind: 'retryable' as const,
  code: 'provider_unavailable',
  message: 'Service unavailable',
  definitelyNotAccepted: true,
};

describe('PgDeliveryRepository', () => {
  let orm: MikroORM;
  let repo: PgDeliveryRepository;
  let notifications: PgNotificationRepository;
  let fixture: TenantFixture;

  beforeAll(async () => {
    orm = await migratedOrm();
    repo = new PgDeliveryRepository(orm);
    notifications = new PgNotificationRepository(orm);
  });

  // markStaleSendingUnknown scans all tenants: start every test from empty tables.
  beforeEach(async () => {
    await truncateAll(orm);
    fixture = await createTenantFixture(orm);
  });

  afterAll(closeOrm);

  async function newDelivery(maxAttempts = 3): Promise<number> {
    const base = notificationInput(fixture);
    const result = await notifications.create({
      ...base,
      routing: { ...base.routing, maxAttempts },
    });
    if (result.kind !== 'created') throw new Error('expected created');
    return deliveryIdOf(orm, result.notificationId);
  }

  async function claimOrThrow(deliveryId: number, generation = 1) {
    const claim = await repo.claim(deliveryId, generation, LEASE_MS);
    if (!claim) throw new Error('expected claim');
    return claim;
  }

  /** Leases are compared with the database clock: expire them there. */
  async function expireLease(deliveryId: number) {
    await queryRows(
      orm,
      `update deliveries set lease_expires_at = now() - interval '1 second'
       where id = ? and lease_token is not null`,
      [deliveryId],
    );
  }

  async function makeDue(deliveryId: number) {
    await queryRows(orm, `update deliveries set next_attempt_at = now() where id = ?`, [
      deliveryId,
    ]);
  }

  function attemptFor(claim: ClaimedDelivery): AttemptStart {
    return {
      attemptNumber: claim.attemptsUsed + 1,
      providerInstanceId: fixture.providerInstanceId,
      providerInstanceRevision: 1,
      providerIdempotencyKey: `${claim.deliveryId}-${claim.attemptsUsed + 1}`,
    };
  }

  async function startedAttempt(claim: ClaimedDelivery, attempt: AttemptStart): Promise<number> {
    const attemptId = await repo.startAttempt(claim, attempt);
    if (attemptId === null) throw new Error('expected attempt start');
    return attemptId;
  }

  async function delivery(deliveryId: number) {
    const rows = await queryRows(
      orm,
      `select submission_status, generation, attempts_used, version, lease_token, next_attempt_at,
              receipt_status, last_error_code
       from deliveries where id = ?`,
      [deliveryId],
    );
    return rows[0];
  }

  it('claims a pending delivery with tenant, payload and routing snapshot', async () => {
    const deliveryId = await newDelivery();

    const claim = await claimOrThrow(deliveryId);

    expect(claim).toMatchObject({
      deliveryId,
      tenantId: fixture.tenantId,
      generation: 1,
      version: 1,
      attemptsUsed: 0,
      payload: { channel: 'email', recipient: { email: 'recipient@example.test' } },
      routing: {
        policyId: fixture.routingPolicyId,
        platform: null,
        providerInstanceIds: [fixture.providerInstanceId],
        maxAttempts: 3,
      },
    });
    expect(claim.expiresAt).toBeInstanceOf(Date);
    const [created] = await queryRows(
      orm,
      `select created_at from notifications where id = (select notification_id from deliveries where id = ?)`,
      [deliveryId],
    );
    expect(claim.createdAt).toBeInstanceOf(Date);
    expect(claim.createdAt.getTime()).toBe(toDate(created?.created_at).getTime());
  });

  it('returns null for a stale job of another generation', async () => {
    const deliveryId = await newDelivery();
    expect(await repo.claim(deliveryId, 2, LEASE_MS)).toBeNull();
    expect(await repo.claim(Number.MAX_SAFE_INTEGER, 1, LEASE_MS)).toBeNull();
  });

  it('does not let a second worker claim while the lease is active', async () => {
    const deliveryId = await newDelivery();
    await claimOrThrow(deliveryId);
    expect(await repo.claim(deliveryId, 1, LEASE_MS)).toBeNull();
  });

  it('sets the lease on the database clock, whatever the caller clock', async () => {
    const deliveryId = await newDelivery();
    await claimOrThrow(deliveryId);
    const [row] = await queryRows(
      orm,
      `select extract(epoch from (lease_expires_at - now())) * 1000 as remaining_ms
       from deliveries where id = ?`,
      [deliveryId],
    );
    const remaining = Number(row?.remaining_ms);
    expect(remaining).toBeGreaterThan(LEASE_MS - 5_000);
    expect(remaining).toBeLessThanOrEqual(LEASE_MS);
  });

  it('does not claim a delivery before its next attempt is due (duplicate job)', async () => {
    const deliveryId = await newDelivery();
    await queryRows(
      orm,
      `update deliveries set next_attempt_at = now() + interval '1 minute' where id = ?`,
      [deliveryId],
    );
    expect(await repo.claim(deliveryId, 1, LEASE_MS)).toBeNull();
    await makeDue(deliveryId);
    expect(await repo.claim(deliveryId, 1, LEASE_MS)).not.toBeNull();
  });

  it('fences a worker whose expired lease was taken over', async () => {
    const deliveryId = await newDelivery();
    const stale = await claimOrThrow(deliveryId);
    await expireLease(deliveryId);
    const fresh = await claimOrThrow(deliveryId, 1);

    expect(fresh.version).toBe(stale.version + 1);
    expect(await repo.renewLease(deliveryId, stale.leaseToken, stale.version, LEASE_MS)).toBe(
      false,
    );
    expect(await repo.startAttempt(stale, attemptFor(stale))).toBeNull();
    expect(await repo.markTerminal(stale, 'expired', 'ttl_exceeded')).toBe(false);
    expect(await repo.renewLease(deliveryId, fresh.leaseToken, fresh.version, LEASE_MS)).toBe(true);
    expect(await repo.startAttempt(fresh, attemptFor(fresh))).toEqual(expect.any(Number));
  });

  it('rejects a stale version even with the right lease token', async () => {
    const deliveryId = await newDelivery();
    const claim = await claimOrThrow(deliveryId);
    const outdated = { ...claim, version: claim.version - 1 };

    expect(await repo.startAttempt(outdated, attemptFor(outdated))).toBeNull();
    expect((await delivery(deliveryId))?.submission_status).toBe('pending');
  });

  it('persists the started attempt and sending state before the provider call', async () => {
    const deliveryId = await newDelivery();
    const claim = await claimOrThrow(deliveryId);
    const attempt = attemptFor(claim);

    const attemptId = await repo.startAttempt(claim, attempt);
    expect(attemptId).toEqual(expect.any(Number));

    expect(await delivery(deliveryId)).toMatchObject({
      submission_status: 'sending',
      attempts_used: 1,
    });
    const attempts = await queryRows(
      orm,
      `select attempt_number, outcome, provider_idempotency_key from delivery_attempts where id = ?`,
      [attemptId],
    );
    expect(attempts).toEqual([
      {
        attempt_number: 1,
        outcome: 'started',
        provider_idempotency_key: attempt.providerIdempotencyKey,
      },
    ]);
    // Same claim cannot start a second attempt.
    expect(await repo.startAttempt(claim, { ...attemptFor(claim), attemptNumber: 2 })).toBeNull();
  });

  it('accepts an attempt and never lets the delivery be claimed again', async () => {
    const deliveryId = await newDelivery();
    const claim = await claimOrThrow(deliveryId);
    const attempt = attemptFor(claim);
    const attemptId = await startedAttempt(claim, attempt);

    expect(
      await repo.resolveAttempt(claim, attemptId, {
        outcome: 'accepted',
        externalReference: 'provider-msg-1',
        receiptStatus: 'pending',
      }),
    ).toBe(true);

    expect(await delivery(deliveryId)).toMatchObject({
      submission_status: 'accepted',
      receipt_status: 'pending',
      lease_token: null,
    });
    expect(await repo.claim(deliveryId, 1, LEASE_MS)).toBeNull();
    expect(await repo.markStaleSendingUnknown(10)).toBe(0);
    expect(
      await repo.resolveAttempt(claim, attemptId, {
        outcome: 'accepted',
        externalReference: null,
        receiptStatus: 'unavailable',
      }),
    ).toBe(false);
  });

  it('schedules a retry with the next generation and its outbox event atomically', async () => {
    const deliveryId = await newDelivery();
    const claim = await claimOrThrow(deliveryId);
    const attempt = attemptFor(claim);
    const attemptId = await startedAttempt(claim, attempt);
    const retryAt = new Date(Date.now() + 30_000);

    expect(
      await repo.resolveAttempt(claim, attemptId, {
        outcome: 'rejected',
        error: retryableError,
        next: { kind: 'retry', at: retryAt },
      }),
    ).toBe(true);

    const row = await delivery(deliveryId);
    expect(row).toMatchObject({
      submission_status: 'retry_wait',
      generation: 2,
      lease_token: null,
      last_error_code: 'provider_unavailable',
    });
    const events = await queryRows(
      orm,
      `select generation, status, available_at from outbox_events
       where delivery_id = ? order by generation`,
      [deliveryId],
    );
    expect(events.map((e) => [e.generation, e.status])).toEqual([
      [1, 'pending'],
      [2, 'pending'],
    ]);
    const attempts = await queryRows(
      orm,
      `select outcome, error_kind, error_code from delivery_attempts where id = ?`,
      [attemptId],
    );
    expect(attempts[0]).toEqual({
      outcome: 'rejected',
      error_kind: 'retryable',
      error_code: 'provider_unavailable',
    });

    // The job of the old generation is stale; the new generation is claimable once due.
    expect(await repo.claim(deliveryId, 1, LEASE_MS)).toBeNull();
    expect(await repo.claim(deliveryId, 2, LEASE_MS)).toBeNull();
    await makeDue(deliveryId);
    const next = await claimOrThrow(deliveryId, 2);
    expect(next).toMatchObject({ generation: 2, attemptsUsed: 1 });
    expect(await repo.startAttempt(next, attemptFor(next))).toEqual(expect.any(Number));
  });

  it('does not create the retry outbox event when the fenced update fails', async () => {
    const deliveryId = await newDelivery();
    const claim = await claimOrThrow(deliveryId);
    const attempt = attemptFor(claim);
    const attemptId = await startedAttempt(claim, attempt);

    const result = await repo.resolveAttempt({ ...claim, leaseToken: randomUUID() }, attemptId, {
      outcome: 'rejected',
      error: retryableError,
      next: { kind: 'retry', at: new Date() },
    });

    expect(result).toBe(false);
    expect(await delivery(deliveryId)).toMatchObject({
      submission_status: 'sending',
      generation: 1,
    });
    const attempts = await queryRows(orm, `select outcome from delivery_attempts where id = ?`, [
      attemptId,
    ]);
    expect(attempts[0]?.outcome).toBe('started');
    const events = await queryRows(
      orm,
      `select count(*)::int as n from outbox_events where delivery_id = ?`,
      [deliveryId],
    );
    expect(events[0]?.n).toBe(1);
  });

  it('fails instead of retrying when the attempt budget is exhausted', async () => {
    const deliveryId = await newDelivery(1);
    const claim = await claimOrThrow(deliveryId);
    const attempt = attemptFor(claim);
    const attemptId = await startedAttempt(claim, attempt);

    await repo.resolveAttempt(claim, attemptId, {
      outcome: 'rejected',
      error: retryableError,
      next: { kind: 'retry', at: new Date() },
    });

    expect(await delivery(deliveryId)).toMatchObject({
      submission_status: 'failed',
      generation: 1,
    });
  });

  it('records a definitive rejection as failed', async () => {
    const deliveryId = await newDelivery();
    const claim = await claimOrThrow(deliveryId);
    const attempt = attemptFor(claim);
    const attemptId = await startedAttempt(claim, attempt);

    await repo.resolveAttempt(claim, attemptId, {
      outcome: 'rejected',
      error: { ...retryableError, kind: 'permanent', code: 'invalid_recipient' },
      next: { kind: 'fail' },
    });

    expect(await delivery(deliveryId)).toMatchObject({
      submission_status: 'failed',
      last_error_code: 'invalid_recipient',
    });
  });

  it('records an ambiguous provider result as unknown', async () => {
    const deliveryId = await newDelivery();
    const claim = await claimOrThrow(deliveryId);
    const attempt = attemptFor(claim);
    const attemptId = await startedAttempt(claim, attempt);

    await repo.resolveAttempt(claim, attemptId, {
      outcome: 'unknown',
      reason: 'read timeout',
      externalReference: null,
    });

    expect((await delivery(deliveryId))?.submission_status).toBe('unknown');
    expect(await repo.claim(deliveryId, 1, LEASE_MS)).toBeNull();
  });

  it('marks a not yet sent delivery terminal (expired or suppressed)', async () => {
    const deliveryId = await newDelivery();
    const claim = await claimOrThrow(deliveryId);

    expect(await repo.markTerminal(claim, 'suppressed', 'recipient_suppressed')).toBe(true);
    expect((await delivery(deliveryId))?.submission_status).toBe('suppressed');
    expect(await repo.claim(deliveryId, 1, LEASE_MS)).toBeNull();
  });

  it('moves stale sending deliveries to unknown, never back to pending', async () => {
    const deliveryId = await newDelivery();
    const claim = await claimOrThrow(deliveryId);
    const attempt = attemptFor(claim);
    const attemptId = await startedAttempt(claim, attempt);

    expect(await repo.markStaleSendingUnknown(10)).toBe(0);
    await expireLease(deliveryId);
    expect(await repo.markStaleSendingUnknown(10)).toBe(1);

    expect(await delivery(deliveryId)).toMatchObject({
      submission_status: 'unknown',
      lease_token: null,
      last_error_code: 'lease_expired',
    });
    const attempts = await queryRows(orm, `select outcome from delivery_attempts where id = ?`, [
      attemptId,
    ]);
    expect(attempts[0]?.outcome).toBe('unknown');
    // The old worker finishing late cannot overwrite the recovery decision.
    expect(
      await repo.resolveAttempt(claim, attemptId, {
        outcome: 'accepted',
        externalReference: 'late',
        receiptStatus: 'unavailable',
      }),
    ).toBe(false);
    expect(await repo.claim(deliveryId, 1, LEASE_MS)).toBeNull();
  });

  it('resolveAttempt and the stale-lease recovery never deadlock (same lock order)', async () => {
    for (let round = 0; round < 15; round += 1) {
      const deliveryId = await newDelivery();
      const claim = await claimOrThrow(deliveryId);
      const attempt = attemptFor(claim);
      const attemptId = await startedAttempt(claim, attempt);
      await expireLease(deliveryId);

      const [resolved, moved] = await Promise.all([
        repo.resolveAttempt(claim, attemptId, {
          outcome: 'accepted',
          externalReference: `msg-${round}`,
          receiptStatus: 'unavailable',
        }),
        repo.markStaleSendingUnknown(10),
      ]);

      // Exactly one of them wins, and delivery and attempt always agree.
      expect(Number(resolved) + moved).toBe(1);
      const row = await delivery(deliveryId);
      const [attemptRow] = await queryRows(
        orm,
        `select outcome from delivery_attempts where id = ?`,
        [attemptId],
      );
      expect([row?.submission_status, attemptRow?.outcome]).toEqual(
        resolved ? ['accepted', 'accepted'] : ['unknown', 'unknown'],
      );
    }
  });
});
