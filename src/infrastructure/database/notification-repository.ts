import { randomUUID } from 'node:crypto';
import type { Channel, ChannelPayload } from '../../contracts/channels.js';
import type { ReceiptStatus, SubmissionStatus } from '../../contracts/statuses.js';
import type {
  AttemptSummary,
  CreateNotificationInput,
  CreateNotificationResult,
  IdempotencyRecord,
  ListNotificationsFilter,
  NotificationDetail,
  NotificationRepository,
  NotificationSummary,
} from '../../application/ports/repositories.js';
import {
  decodeCursor,
  encodeCursor,
  forkEm,
  isUuid,
  num,
  str,
  strOrNull,
  toDate,
  toDateOrNull,
  type Orm,
  type Row,
} from './sql-support.js';

/** Raw recipient identifier stored on the delivery (no destructive normalization). */
export function recipientOf(payload: ChannelPayload): string {
  switch (payload.channel) {
    case 'email':
      return payload.recipient.email;
    case 'sms':
      return payload.recipient.phoneNumber;
    case 'push':
      return payload.recipient.deviceToken;
    case 'messaging':
      return payload.recipient.platform === 'whatsapp'
        ? payload.recipient.phoneNumber
        : payload.recipient.chatId;
  }
}

const SUMMARY_COLUMNS = `
  n.id, n.channel, n.routing_snapshot->>'platform' as platform, n.routing_key, n.created_at,
  d.id as delivery_id, d.submission_status, d.receipt_status, d.updated_at,
  d.last_error_code, d.last_error_message`;

/** First delivery of each notification (exactly one in the MVP). */
const DELIVERY_JOIN = `
  join lateral (
    select * from deliveries d
    where d.tenant_id = n.tenant_id and d.notification_id = n.id
    order by d.created_at, d.id
    limit 1
  ) d on true`;

function toSummary(row: Row): NotificationSummary {
  const createdAt = toDate(row.created_at);
  const deliveryUpdatedAt = toDate(row.updated_at);
  return {
    id: str(row.id),
    channel: str(row.channel) as Channel,
    platform: strOrNull(row.platform),
    routingKey: str(row.routing_key),
    submissionStatus: str(row.submission_status) as SubmissionStatus,
    receiptStatus: str(row.receipt_status) as ReceiptStatus,
    createdAt,
    updatedAt: deliveryUpdatedAt > createdAt ? deliveryUpdatedAt : createdAt,
  };
}

export class PgNotificationRepository implements NotificationRepository {
  constructor(private readonly orm: Orm) {}

  async create(input: CreateNotificationInput): Promise<CreateNotificationResult> {
    const em = forkEm(this.orm);
    return em.transactional(async (tx) => {
      const notificationId = randomUUID();
      // ON CONFLICT waits for a concurrent in-flight insert of the same key and then skips,
      // so exactly one request creates the notification.
      const inserted = await tx.execute<Row[]>(
        `insert into notifications
           (id, tenant_id, idempotency_key, request_hash, channel, routing_key, routing_policy_id,
            payload, metadata, routing_snapshot)
         values (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb)
         on conflict on constraint notifications_idempotency_unique do nothing
         returning id`,
        [
          notificationId,
          input.tenantId,
          input.idempotencyKey,
          input.requestHash,
          input.payload.channel,
          input.routingKey,
          input.routing.policyId,
          JSON.stringify(input.payload),
          JSON.stringify(input.metadata),
          JSON.stringify(input.routing),
        ],
      );

      if (inserted.length === 0) {
        // Read committed: this statement sees the row committed by the winning request.
        const existing = await tx.execute<Row[]>(
          `select id, request_hash from notifications where tenant_id = ? and idempotency_key = ?`,
          [input.tenantId, input.idempotencyKey],
        );
        const row = existing[0];
        if (!row) throw new Error('idempotency conflict without visible notification');
        return str(row.request_hash) === input.requestHash
          ? { kind: 'replayed', notificationId: str(row.id) }
          : { kind: 'conflict' };
      }

      const deliveryId = randomUUID();
      await tx.execute(
        `insert into deliveries
           (id, tenant_id, notification_id, channel, recipient, submission_status, receipt_status,
            generation, max_attempts, expires_at)
         values (?, ?, ?, ?, ?, 'pending', 'unavailable', 1, ?, ?)`,
        [
          deliveryId,
          input.tenantId,
          notificationId,
          input.payload.channel,
          recipientOf(input.payload),
          input.routing.maxAttempts,
          input.expiresAt,
        ],
      );
      await tx.execute(
        `insert into outbox_events (id, tenant_id, delivery_id, generation, event_type, status)
         values (?, ?, ?, 1, 'dispatch_delivery', 'pending')`,
        [randomUUID(), input.tenantId, deliveryId],
      );
      return { kind: 'created', notificationId };
    });
  }

  async findByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<IdempotencyRecord | null> {
    if (!isUuid(tenantId)) return null;
    const found = await forkEm(this.orm).execute<Row[]>(
      `select id, request_hash from notifications where tenant_id = ? and idempotency_key = ?`,
      [tenantId, idempotencyKey],
    );
    const row = found[0];
    return row ? { notificationId: str(row.id), requestHash: str(row.request_hash) } : null;
  }

  async findById(tenantId: string, id: string): Promise<NotificationDetail | null> {
    if (!isUuid(tenantId) || !isUuid(id)) return null;
    const em = forkEm(this.orm);
    const found = await em.execute<Row[]>(
      `select ${SUMMARY_COLUMNS} from notifications n ${DELIVERY_JOIN}
       where n.tenant_id = ? and n.id = ?`,
      [tenantId, id],
    );
    const row = found[0];
    if (!row) return null;

    const attemptRows = await em.execute<Row[]>(
      `select attempt_number, outcome, started_at, finished_at, error_code
       from delivery_attempts
       where tenant_id = ? and delivery_id = ?
       order by attempt_number`,
      [tenantId, str(row.delivery_id)],
    );
    const attempts: AttemptSummary[] = attemptRows.map((a) => ({
      number: num(a.attempt_number),
      outcome: str(a.outcome) as AttemptSummary['outcome'],
      startedAt: toDate(a.started_at),
      finishedAt: toDateOrNull(a.finished_at),
      errorCode: strOrNull(a.error_code),
    }));
    const code = strOrNull(row.last_error_code);
    return {
      ...toSummary(row),
      attempts,
      lastError: code === null ? null : { code, message: strOrNull(row.last_error_message) ?? '' },
    };
  }

  async list(
    tenantId: string,
    filter: ListNotificationsFilter,
  ): Promise<{ items: NotificationSummary[]; nextCursor: string | null }> {
    const limit = Math.max(1, Math.min(filter.limit, 200));
    if (!isUuid(tenantId)) return { items: [], nextCursor: null };

    const where: string[] = ['n.tenant_id = ?'];
    const params: unknown[] = [tenantId];
    if (filter.channel !== undefined) {
      where.push('n.channel = ?');
      params.push(filter.channel);
    }
    if (filter.status !== undefined) {
      where.push('d.submission_status = ?');
      params.push(filter.status);
    }
    if (filter.createdFrom !== undefined) {
      where.push('n.created_at >= ?');
      params.push(filter.createdFrom);
    }
    if (filter.createdTo !== undefined) {
      where.push('n.created_at < ?');
      params.push(filter.createdTo);
    }
    if (filter.cursor !== undefined) {
      const cursor = decodeCursor(filter.cursor);
      where.push('(n.created_at, n.id) < (?::timestamptz, ?::uuid)');
      params.push(cursor.createdAt, cursor.id);
    }
    params.push(limit + 1);

    const em = forkEm(this.orm);
    const found = await em.execute<Row[]>(
      `select ${SUMMARY_COLUMNS} from notifications n ${DELIVERY_JOIN}
       where ${where.join(' and ')}
       order by n.created_at desc, n.id desc
       limit ?`,
      params,
    );
    const items = found.slice(0, limit).map(toSummary);
    const last = items.at(-1);
    const nextCursor = found.length > limit && last ? encodeCursor(last.createdAt, last.id) : null;
    return { items, nextCursor };
  }

  /**
   * Backlog guard: events due for publication (database clock) and not yet published. Events
   * scheduled in the future (retry_wait backoff, deferrals) are not a backlog: counting them
   * would make a provider outage look like a queue outage (API 503, readiness down).
   */
  async countPendingOutbox(): Promise<number> {
    const em = forkEm(this.orm);
    const result = await em.execute<Row[]>(
      `select count(*)::int as count from outbox_events
       where status <> 'published' and available_at <= now()`,
    );
    return num(result[0]?.count ?? 0);
  }
}
