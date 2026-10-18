import type { QueryResult } from '@mikro-orm/core';
import type { ChannelPayload } from '../../contracts/channels.js';
import type { SubmissionStatus } from '../../contracts/statuses.js';
import type {
  AttemptResolution,
  AttemptStart,
  ClaimedDelivery,
  DeliveryRepository,
  RoutingSnapshot,
} from '../../application/ports/repositories.js';
import {
  FencingRollback,
  forkEm,
  isId,
  isUniqueViolation,
  isUuid,
  num,
  str,
  toDate,
  toId,
  type Orm,
  type Row,
} from './sql-support.js';

const RUNNABLE = `('pending', 'retry_wait')`;
const MAX_ERROR_MESSAGE = 1000;

/**
 * Leases are set and compared with the database clock only (`now()`), so workers and
 * dispatchers with skewed clocks agree on expiry.
 *
 * Every mutation after claim is fenced on (id, lease_token, version): a worker whose lease was
 * taken over, or whose delivery was moved to 'unknown', cannot overwrite the newer state.
 */
const FENCE = `id = ? and lease_token = ? and version = ?`;

function fenceParams(claim: ClaimedDelivery): unknown[] {
  return [claim.deliveryId, claim.leaseToken, claim.version];
}

export class PgDeliveryRepository implements DeliveryRepository {
  constructor(private readonly orm: Orm) {}

  async claim(
    deliveryId: number,
    generation: number,
    leaseMs: number,
  ): Promise<ClaimedDelivery | null> {
    if (!isId(deliveryId)) return null;
    const em = forkEm(this.orm);
    // Accepted/terminal/sending deliveries, other generations and deliveries not yet due (a
    // duplicate job published before a deferral) never match. Database clock only.
    const found = await em.execute<Row[]>(
      `with claimed as (
         update deliveries
         set lease_token = gen_random_uuid(),
             lease_expires_at = now() + (? * interval '1 millisecond'),
             version = version + 1, updated_at = now()
         where id = ? and generation = ? and submission_status in ${RUNNABLE}
           and (lease_token is null or lease_expires_at <= now())
           and (next_attempt_at is null or next_attempt_at <= now())
         returning id, tenant_id, notification_id, generation, version, lease_token,
                   attempts_used, max_attempts, expires_at
       )
       select c.*, n.payload, n.routing_snapshot, n.created_at as notification_created_at
       from claimed c
       join notifications n on n.tenant_id = c.tenant_id and n.id = c.notification_id`,
      [leaseMs, deliveryId, generation],
    );
    const row = found[0];
    if (!row) return null;
    const snapshot = row.routing_snapshot as RoutingSnapshot;
    return {
      deliveryId: toId(row.id),
      tenantId: toId(row.tenant_id),
      notificationId: toId(row.notification_id),
      generation: num(row.generation),
      version: num(row.version),
      leaseToken: str(row.lease_token),
      payload: row.payload as ChannelPayload,
      // The delivery row owns the attempt budget (a manual retry may grant a new one).
      routing: { ...snapshot, maxAttempts: num(row.max_attempts) },
      attemptsUsed: num(row.attempts_used),
      expiresAt: toDate(row.expires_at),
      createdAt: toDate(row.notification_created_at),
    };
  }

  async renewLease(
    deliveryId: number,
    leaseToken: string,
    version: number,
    leaseMs: number,
  ): Promise<boolean> {
    if (!isId(deliveryId) || !isUuid(leaseToken)) return false;
    const em = forkEm(this.orm);
    const result = await em.execute<QueryResult>(
      `update deliveries
       set lease_expires_at = now() + (? * interval '1 millisecond'), updated_at = now()
       where id = ? and lease_token = ? and version = ?
         and submission_status in ('pending', 'retry_wait', 'sending')`,
      [leaseMs, deliveryId, leaseToken, version],
      'run',
    );
    return result.affectedRows === 1;
  }

  async startAttempt(claim: ClaimedDelivery, attempt: AttemptStart): Promise<number | null> {
    const em = forkEm(this.orm);
    try {
      return await em.transactional(async (tx) => {
        const updated = await tx.execute<QueryResult>(
          `update deliveries
           set submission_status = 'sending', attempts_used = attempts_used + 1,
               next_attempt_at = null, updated_at = now()
           where ${FENCE} and generation = ? and submission_status in ${RUNNABLE}
             and lease_expires_at > now()
             and attempts_used < max_attempts
             and attempts_used + 1 = ?`,
          [...fenceParams(claim), claim.generation, attempt.attemptNumber],
          'run',
        );
        if (updated.affectedRows !== 1) throw new FencingRollback();
        const inserted = await tx.execute<Row[]>(
          `insert into delivery_attempts
             (tenant_id, delivery_id, attempt_number, generation, provider_instance_id,
              provider_instance_revision, provider_idempotency_key, outcome, started_at)
           values (?, ?, ?, ?, ?, ?, ?, 'started', now())
           returning id`,
          [
            claim.tenantId,
            claim.deliveryId,
            attempt.attemptNumber,
            claim.generation,
            attempt.providerInstanceId,
            attempt.providerInstanceRevision,
            attempt.providerIdempotencyKey,
          ],
        );
        return toId(inserted[0]?.id);
      });
    } catch (error) {
      if (error instanceof FencingRollback || isUniqueViolation(error)) return null;
      throw error;
    }
  }

  async resolveAttempt(
    claim: ClaimedDelivery,
    attemptId: number,
    resolution: AttemptResolution,
  ): Promise<boolean> {
    if (!isId(attemptId)) return false;
    const em = forkEm(this.orm);
    try {
      return await em.transactional(async (tx) => {
        const attemptOutcome = resolution.outcome;
        const errorKind = resolution.outcome === 'rejected' ? resolution.error.kind : null;
        const errorCode =
          resolution.outcome === 'rejected'
            ? resolution.error.code
            : resolution.outcome === 'unknown'
              ? 'unknown_outcome'
              : null;
        const errorMessage =
          resolution.outcome === 'rejected'
            ? resolution.error.message
            : resolution.outcome === 'unknown'
              ? resolution.reason
              : null;
        const externalReference =
          resolution.outcome === 'rejected' ? null : resolution.externalReference;

        const fence = `${FENCE} and generation = ? and submission_status = 'sending'`;
        const params = [...fenceParams(claim), claim.generation];
        let deliveryUpdated: number;

        if (resolution.outcome === 'accepted') {
          // A receipt already advanced by a webhook is never degraded.
          deliveryUpdated = (
            await tx.execute<QueryResult>(
              `update deliveries
               set submission_status = 'accepted',
                   receipt_status = case when receipt_status in ('delivered', 'undeliverable')
                                         then receipt_status else ? end,
                   lease_token = null, lease_expires_at = null, next_attempt_at = null,
                   last_error_code = null, last_error_message = null, updated_at = now()
               where ${fence}`,
              [resolution.receiptStatus, ...params],
              'run',
            )
          ).affectedRows;
        } else if (resolution.outcome === 'unknown') {
          deliveryUpdated = (
            await tx.execute<QueryResult>(
              `update deliveries
               set submission_status = 'unknown', lease_token = null, lease_expires_at = null,
                   next_attempt_at = null, last_error_code = 'unknown_outcome',
                   last_error_message = ?, terminal_reason = 'ambiguous_provider_result',
                   updated_at = now()
               where ${fence}`,
              [resolution.reason.slice(0, MAX_ERROR_MESSAGE), ...params],
              'run',
            )
          ).affectedRows;
        } else if (resolution.next.kind === 'fail') {
          deliveryUpdated = (
            await tx.execute<QueryResult>(
              `update deliveries
               set submission_status = 'failed', lease_token = null, lease_expires_at = null,
                   next_attempt_at = null, last_error_code = ?, last_error_message = ?,
                   terminal_reason = ?, updated_at = now()
               where ${fence}`,
              [
                resolution.error.code,
                resolution.error.message.slice(0, MAX_ERROR_MESSAGE),
                resolution.error.code,
                ...params,
              ],
              'run',
            )
          ).affectedRows;
        } else {
          // Retry: the attempt budget is enforced here; an exhausted budget fails instead.
          const retryAt = resolution.next.at;
          const updated = await tx.execute<Row[]>(
            `update deliveries
             set submission_status = case when attempts_used < max_attempts
                                          then 'retry_wait' else 'failed' end,
                 generation = case when attempts_used < max_attempts
                                   then generation + 1 else generation end,
                 next_attempt_at = case when attempts_used < max_attempts then ?::timestamptz end,
                 terminal_reason = case when attempts_used < max_attempts
                                        then null else 'attempts_exhausted' end,
                 lease_token = null, lease_expires_at = null,
                 last_error_code = ?, last_error_message = ?, updated_at = now()
             where ${fence}
             returning submission_status, generation`,
            [
              retryAt,
              resolution.error.code,
              resolution.error.message.slice(0, MAX_ERROR_MESSAGE),
              ...params,
            ],
          );
          deliveryUpdated = updated.length;
          const row = updated[0];
          if (row && str(row.submission_status) === 'retry_wait') {
            await tx.execute(
              `insert into outbox_events
                 (tenant_id, delivery_id, generation, event_type, status, available_at)
               values (?, ?, ?, 'dispatch_delivery', 'pending', ?)`,
              [claim.tenantId, claim.deliveryId, num(row.generation), retryAt],
            );
          }
        }

        if (deliveryUpdated !== 1) throw new FencingRollback();

        // Attempt row second: same lock order as markStaleSendingUnknown (deliveries, then
        // attempts), so the two can never deadlock.
        const attemptUpdated = await tx.execute<QueryResult>(
          `update delivery_attempts
           set outcome = ?, finished_at = now(), error_kind = ?, error_code = ?,
               error_message = ?, external_reference = coalesce(?, external_reference)
           where id = ? and tenant_id = ? and delivery_id = ? and generation = ?
             and outcome = 'started'`,
          [
            attemptOutcome,
            errorKind,
            errorCode,
            errorMessage?.slice(0, MAX_ERROR_MESSAGE) ?? null,
            externalReference,
            attemptId,
            claim.tenantId,
            claim.deliveryId,
            claim.generation,
          ],
          'run',
        );
        if (attemptUpdated.affectedRows !== 1) throw new FencingRollback();
        return true;
      });
    } catch (error) {
      if (error instanceof FencingRollback) return false;
      throw error;
    }
  }

  async markTerminal(
    claim: ClaimedDelivery,
    status: Extract<SubmissionStatus, 'failed' | 'suppressed' | 'expired'>,
    reasonCode: string,
  ): Promise<boolean> {
    // Only before a send: once 'sending', the outcome goes through resolveAttempt or 'unknown'.
    const em = forkEm(this.orm);
    const result = await em.execute<QueryResult>(
      `update deliveries
       set submission_status = ?, terminal_reason = ?, lease_token = null,
           lease_expires_at = null, next_attempt_at = null, updated_at = now()
       where ${FENCE} and generation = ? and submission_status in ${RUNNABLE}`,
      [status, reasonCode, ...fenceParams(claim), claim.generation],
      'run',
    );
    return result.affectedRows === 1;
  }

  async markStaleSendingUnknown(limit: number): Promise<number> {
    const em = forkEm(this.orm);
    const result = await em.execute<Row[]>(
      `with stale as (
         select id from deliveries
         where submission_status = 'sending' and lease_expires_at <= now()
         order by lease_expires_at
         limit ?
         for update skip locked
       ), moved as (
         update deliveries d
         set submission_status = 'unknown', lease_token = null, lease_expires_at = null,
             version = d.version + 1, last_error_code = 'lease_expired',
             last_error_message = 'Worker lease expired while sending',
             terminal_reason = 'lease_expired_while_sending', updated_at = now()
         from stale
         where d.id = stale.id
         returning d.id, d.tenant_id, d.generation
       ), attempts as (
         update delivery_attempts a
         set outcome = 'unknown', finished_at = now(), error_code = 'lease_expired'
         from moved
         where a.tenant_id = moved.tenant_id and a.delivery_id = moved.id
           and a.generation = moved.generation and a.outcome = 'started'
         returning a.id
       )
       select (select count(*) from moved)::int as moved, (select count(*) from attempts)::int as attempts`,
      [limit],
    );
    return num(result[0]?.moved ?? 0);
  }
}
