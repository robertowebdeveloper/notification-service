import type { QueryResult } from '@mikro-orm/core';
import type { Channel, ChannelPayload } from '../../contracts/channels.js';
import type { ProviderErrorKind } from '../../contracts/provider-port.js';
import type { AttemptOutcome, ReceiptStatus, SubmissionStatus } from '../../contracts/statuses.js';
import type {
  AttemptRecord,
  DeliveryControlRepository,
  DeliveryTarget,
  UnknownDelivery,
} from '../../application/ports/delivery-control.js';
import type { ClaimedDelivery } from '../../application/ports/repositories.js';
import {
  FencingRollback,
  forkEm,
  isId,
  num,
  str,
  strOrNull,
  toDate,
  toDateOrNull,
  toId,
  type Orm,
  type Row,
} from './sql-support.js';

/**
 * PostgreSQL implementation of the delivery-control operations (same conventions as
 * `PgDeliveryRepository`: forked EM per call, fenced conditional updates).
 */
const FENCE = `id = ? and lease_token = ? and version = ? and generation = ?`;
const RUNNABLE = `('pending', 'retry_wait')`;

function fence(claim: ClaimedDelivery): unknown[] {
  return [claim.deliveryId, claim.leaseToken, claim.version, claim.generation];
}

const ATTEMPT_COLUMNS = `a.id as attempt_id, a.attempt_number, a.generation as attempt_generation,
  a.provider_instance_id, a.provider_idempotency_key, a.outcome, a.error_kind, a.error_code,
  a.external_reference, a.started_at, a.finished_at`;

function toAttempt(row: Row): AttemptRecord {
  return {
    attemptId: toId(row.attempt_id),
    attemptNumber: num(row.attempt_number),
    generation: num(row.attempt_generation),
    providerInstanceId: toId(row.provider_instance_id),
    providerIdempotencyKey: str(row.provider_idempotency_key),
    outcome: str(row.outcome) as AttemptOutcome,
    errorKind: strOrNull(row.error_kind) as ProviderErrorKind | null,
    errorCode: strOrNull(row.error_code),
    externalReference: strOrNull(row.external_reference),
    startedAt: toDate(row.started_at),
    finishedAt: toDateOrNull(row.finished_at),
  };
}

export class PgDeliveryControlRepository implements DeliveryControlRepository {
  constructor(private readonly orm: Orm) {}

  async attemptHistory(tenantId: number, deliveryId: number): Promise<AttemptRecord[]> {
    if (!isId(tenantId) || !isId(deliveryId)) return [];
    const rows = await forkEm(this.orm).execute<Row[]>(
      `select ${ATTEMPT_COLUMNS} from delivery_attempts a
       where a.tenant_id = ? and a.delivery_id = ?
       order by a.attempt_number`,
      [tenantId, deliveryId],
    );
    return rows.map(toAttempt);
  }

  async defer(claim: ClaimedDelivery, delayMs: number, reasonCode: string): Promise<boolean> {
    const em = forkEm(this.orm);
    try {
      return await em.transactional(async (tx) => {
        // Database clock; never past the expiry: the next claim then closes the delivery.
        const updated = await tx.execute<Row[]>(
          `update deliveries
           set lease_token = null, lease_expires_at = null,
               next_attempt_at = least(now() + (? * interval '1 millisecond'), expires_at),
               updated_at = now()
           where ${FENCE} and submission_status in ${RUNNABLE}
           returning next_attempt_at`,
          [Math.max(0, Math.round(delayMs)), ...fence(claim)],
        );
        const row = updated[0];
        if (!row) throw new FencingRollback();
        const at = toDate(row.next_attempt_at);
        // Any status: 'publishing' too, since the job may run before the dispatcher acknowledged
        // the publication (its ack then misses the lease and the event stays pending for `at`).
        await tx.execute<QueryResult>(
          `update outbox_events
           set status = 'pending', available_at = ?, lease_token = null, lease_expires_at = null,
               last_error = ?, updated_at = now()
           where tenant_id = ? and delivery_id = ? and generation = ?
             and event_type = 'dispatch_delivery'`,
          [
            at,
            `deferred:${reasonCode}`.slice(0, 2000),
            claim.tenantId,
            claim.deliveryId,
            claim.generation,
          ],
          'run',
        );
        return true;
      });
    } catch (error) {
      if (error instanceof FencingRollback) return false;
      throw error;
    }
  }

  async returnToUnknown(claim: ClaimedDelivery, reasonCode: string): Promise<boolean> {
    const result = await forkEm(this.orm).execute<QueryResult>(
      `update deliveries
       set submission_status = 'unknown', lease_token = null, lease_expires_at = null,
           next_attempt_at = null, terminal_reason = ?, updated_at = now()
       where ${FENCE} and submission_status = 'retry_wait'`,
      [reasonCode, ...fence(claim)],
      'run',
    );
    return result.affectedRows === 1;
  }

  async findUnknown(minIntervalMs: number, limit: number): Promise<UnknownDelivery[]> {
    const rows = await forkEm(this.orm).execute<Row[]>(
      `select d.tenant_id, d.id as delivery_id, d.generation, d.version, d.attempts_used,
              d.max_attempts, d.expires_at, ${ATTEMPT_COLUMNS},
              (select min(f.started_at) from delivery_attempts f
                where f.tenant_id = a.tenant_id and f.delivery_id = a.delivery_id
                  and f.provider_instance_id = a.provider_instance_id
                  and f.provider_idempotency_key = a.provider_idempotency_key) as key_first_used_at
       from deliveries d
       join lateral (
         select * from delivery_attempts x
         where x.tenant_id = d.tenant_id and x.delivery_id = d.id
         order by x.attempt_number desc
         limit 1
       ) a on true
       where d.submission_status = 'unknown' and d.lease_token is null
         and d.updated_at <= now() - (? * interval '1 millisecond')
       order by d.updated_at
       limit ?`,
      [minIntervalMs, limit],
    );
    return rows.map((row) => ({
      tenantId: toId(row.tenant_id),
      deliveryId: toId(row.delivery_id),
      generation: num(row.generation),
      version: num(row.version),
      attemptsUsed: num(row.attempts_used),
      maxAttempts: num(row.max_attempts),
      expiresAt: toDate(row.expires_at),
      lastAttempt: toAttempt(row),
      keyFirstUsedAt: toDate(row.key_first_used_at),
    }));
  }

  async touchUnknown(tenantId: number, deliveryId: number, version: number): Promise<boolean> {
    if (!isId(tenantId) || !isId(deliveryId)) return false;
    const result = await forkEm(this.orm).execute<QueryResult>(
      `update deliveries set updated_at = now()
       where tenant_id = ? and id = ? and version = ? and submission_status = 'unknown'`,
      [tenantId, deliveryId, version],
      'run',
    );
    return result.affectedRows === 1;
  }

  async resolveUnknownAccepted(
    tenantId: number,
    deliveryId: number,
    version: number | null,
    receiptStatus: ReceiptStatus,
    externalReference: string | null,
  ): Promise<boolean> {
    if (!isId(tenantId) || !isId(deliveryId)) return false;
    const em = forkEm(this.orm);
    try {
      return await em.transactional(async (tx) => {
        // `unknown`, or `retry_wait` waiting for a safe replay of an ambiguous attempt (its
        // latest attempt is `unknown`; nothing is in flight since no attempt is `started`).
        // A worker that already claimed the replay is fenced by the version bump: every one of
        // its writes (startAttempt, defer, returnToUnknown, markTerminal) checks the version.
        const updated = await tx.execute<Row[]>(
          `update deliveries d
           set submission_status = 'accepted',
               receipt_status = case when receipt_status in ('delivered', 'undeliverable')
                                     then receipt_status else ? end,
               version = version + 1, next_attempt_at = null, lease_token = null,
               lease_expires_at = null, last_error_code = null, last_error_message = null,
               terminal_reason = null, updated_at = now()
           where d.tenant_id = ? and d.id = ?
             and (
               (d.submission_status = 'unknown' and d.lease_token is null
                 and (?::int is null or d.version = ?::int))
               or (d.submission_status = 'retry_wait' and (
                 select x.outcome from delivery_attempts x
                 where x.tenant_id = d.tenant_id and x.delivery_id = d.id
                 order by x.attempt_number desc
                 limit 1) = 'unknown')
             )
           returning d.id`,
          [receiptStatus, tenantId, deliveryId, version, version],
        );
        if (!updated[0]) throw new FencingRollback();
        // The latest ambiguous attempt, whatever its generation: a scheduled replay bumped the
        // delivery generation without creating an attempt yet.
        await tx.execute<QueryResult>(
          `update delivery_attempts
           set outcome = 'accepted', finished_at = coalesce(finished_at, now()),
               external_reference = coalesce(external_reference, ?)
           where id = (
             select id from delivery_attempts
             where tenant_id = ? and delivery_id = ? and outcome = 'unknown'
             order by attempt_number desc
             limit 1
           )`,
          [externalReference, tenantId, deliveryId],
          'run',
        );
        return true;
      });
    } catch (error) {
      if (error instanceof FencingRollback) return false;
      throw error;
    }
  }

  async scheduleSafeReplay(
    tenantId: number,
    deliveryId: number,
    version: number,
    at: Date,
  ): Promise<boolean> {
    if (!isId(tenantId) || !isId(deliveryId)) return false;
    const em = forkEm(this.orm);
    try {
      return await em.transactional(async (tx) => {
        const updated = await tx.execute<Row[]>(
          `update deliveries
           set submission_status = 'retry_wait', generation = generation + 1,
               version = version + 1, next_attempt_at = ?, terminal_reason = null,
               updated_at = now()
           where tenant_id = ? and id = ? and version = ? and submission_status = 'unknown'
             and lease_token is null and attempts_used < max_attempts and expires_at > ?
           returning generation`,
          [at, tenantId, deliveryId, version, at],
        );
        const row = updated[0];
        if (!row) throw new FencingRollback();
        await tx.execute(
          `insert into outbox_events
             (tenant_id, delivery_id, generation, event_type, status, available_at)
           values (?, ?, ?, 'dispatch_delivery', 'pending', ?)`,
          [tenantId, deliveryId, num(row.generation), at],
        );
        return true;
      });
    } catch (error) {
      if (error instanceof FencingRollback) return false;
      throw error;
    }
  }

  async findTarget(tenantId: number, deliveryId: number): Promise<DeliveryTarget | null> {
    if (!isId(tenantId) || !isId(deliveryId)) return null;
    const rows = await forkEm(this.orm).execute<Row[]>(
      `select d.tenant_id, d.id, d.channel, d.submission_status, d.receipt_status, n.payload
       from deliveries d
       join notifications n on n.tenant_id = d.tenant_id and n.id = d.notification_id
       where d.tenant_id = ? and d.id = ?`,
      [tenantId, deliveryId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      tenantId: toId(row.tenant_id),
      deliveryId: toId(row.id),
      channel: str(row.channel) as Channel,
      submissionStatus: str(row.submission_status) as SubmissionStatus,
      receiptStatus: str(row.receipt_status) as ReceiptStatus,
      payload: row.payload as ChannelPayload,
    };
  }
}
