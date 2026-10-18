import type { QueryResult } from '@mikro-orm/core';
import { randomUUID } from 'node:crypto';
import type { SubmissionStatus } from '../../contracts/statuses.js';
import type {
  ManualRetryInput,
  ManualRetryRepository,
  ManualRetryResult,
} from '../../application/ports/repositories.js';
import { forkEm, isUuid, num, str, type Orm, type Row } from './sql-support.js';

export const MANUAL_RETRY_OPERATION = 'notification.manual_retry';

/**
 * Manual retry in a single transaction serialized by a row lock on the delivery.
 *
 * Idempotency: the retry key is recorded in the audit event written by the same transaction
 * (`audit_events.details.idempotencyKey`, scoped by tenant + notification). A concurrent request
 * with the same key waits on the delivery lock and then sees the committed audit row, so it
 * returns `replayed` with the same generation; no extra table is required.
 */
export class PgManualRetryRepository implements ManualRetryRepository {
  constructor(private readonly orm: Orm) {}

  async retryFailed(input: ManualRetryInput): Promise<ManualRetryResult> {
    if (!isUuid(input.tenantId) || !isUuid(input.notificationId)) return { kind: 'not_found' };
    if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) {
      throw new RangeError('maxAttempts must be a positive integer');
    }
    return forkEm(this.orm).transactional(async (tx): Promise<ManualRetryResult> => {
      const locked = await tx.execute<Row[]>(
        `select d.id, d.submission_status, d.generation, d.attempts_used, d.max_attempts
         from deliveries d
         where d.tenant_id = ? and d.notification_id = ?
         order by d.created_at, d.id
         limit 1
         for update`,
        [input.tenantId, input.notificationId],
      );
      const delivery = locked[0];
      if (!delivery) return { kind: 'not_found' };
      const deliveryId = str(delivery.id);

      const previous = await tx.execute<Row[]>(
        `select details->>'generation' as generation
         from audit_events
         where tenant_id = ? and operation = ? and resource_type = 'notification'
           and resource_id = ? and details->>'idempotencyKey' = ?
         order by occurred_at
         limit 1`,
        [input.tenantId, MANUAL_RETRY_OPERATION, input.notificationId, input.retryIdempotencyKey],
      );
      if (previous[0]) return { kind: 'replayed', generation: num(previous[0].generation) };

      const status = str(delivery.submission_status) as SubmissionStatus;
      if (status !== 'failed') return { kind: 'not_retryable', submissionStatus: status };

      // Every attempt must be a certain rejection: started/unknown/accepted are never overridden.
      const uncertain = await tx.execute<Row[]>(
        `select count(*)::int as count from delivery_attempts
         where tenant_id = ? and delivery_id = ? and outcome <> 'rejected'`,
        [input.tenantId, deliveryId],
      );
      if (num(uncertain[0]?.count ?? 0) > 0) {
        return { kind: 'not_retryable', submissionStatus: status };
      }

      const updated = await tx.execute<Row[]>(
        `update deliveries d
         set submission_status = 'retry_wait', generation = d.generation + 1,
             max_attempts = d.attempts_used + ?, next_attempt_at = ?,
             expires_at = greatest(
               d.expires_at,
               ?::timestamptz + (coalesce(
                 (select rp.ttl_seconds from notifications n
                  join routing_policies rp
                    on rp.tenant_id = n.tenant_id and rp.id = n.routing_policy_id
                  where n.tenant_id = d.tenant_id and n.id = d.notification_id),
                 86400) * interval '1 second')),
             terminal_reason = null, lease_token = null, lease_expires_at = null,
             version = d.version + 1, updated_at = now()
         where d.tenant_id = ? and d.id = ? and d.submission_status = 'failed'
         returning d.generation, d.max_attempts`,
        [input.maxAttempts, input.now, input.now, input.tenantId, deliveryId],
      );
      const row = updated[0];
      if (!row) throw new Error('locked delivery could not be updated');
      const generation = num(row.generation);

      await tx.execute<QueryResult>(
        `insert into outbox_events
           (id, tenant_id, delivery_id, generation, event_type, status, available_at)
         values (?, ?, ?, ?, 'dispatch_delivery', 'pending', ?)`,
        [randomUUID(), input.tenantId, deliveryId, generation, input.now],
        'run',
      );
      await tx.execute<QueryResult>(
        `insert into audit_events
           (id, tenant_id, actor, operation, resource_type, resource_id, details)
         values (?, ?, ?, ?, 'notification', ?, ?::jsonb)`,
        [
          randomUUID(),
          input.tenantId,
          `api_key:${input.actorApiKeyId}`,
          MANUAL_RETRY_OPERATION,
          input.notificationId,
          JSON.stringify({
            idempotencyKey: input.retryIdempotencyKey,
            deliveryId,
            previousGeneration: num(delivery.generation),
            generation,
            attemptsUsed: num(delivery.attempts_used),
            grantedAttempts: input.maxAttempts,
            maxAttempts: num(row.max_attempts),
          }),
        ],
        'run',
      );
      return { kind: 'scheduled', generation };
    });
  }
}
