import type { QueryResult } from '@mikro-orm/core';
import type { Channel } from '../../contracts/channels.js';
import type {
  ClaimedOutboxEvent,
  LostPublicationCandidate,
  OutboxRepository,
} from '../../application/ports/repositories.js';
import { forkEm, isId, isUuid, num, str, toDate, toId, type Orm, type Row } from './sql-support.js';

/**
 * Availability, leases and staleness use the database clock only (`now()`), so several
 * dispatchers with skewed clocks agree on what is due and what expired.
 */
export class PgOutboxRepository implements OutboxRepository {
  constructor(private readonly orm: Orm) {}

  /**
   * Claims due pending events, plus 'publishing' events whose lease expired (dispatcher crash).
   * Single statement: row locks with SKIP LOCKED make concurrent claimers disjoint.
   */
  async claimAvailable(limit: number, leaseMs: number): Promise<ClaimedOutboxEvent[]> {
    const em = forkEm(this.orm);
    const claimed = await em.execute<Row[]>(
      `with candidates as (
         select o.id from outbox_events o
         where (o.status = 'pending' and o.available_at <= now())
            or (o.status = 'publishing' and o.lease_expires_at <= now())
         order by o.available_at, o.id
         limit ?
         for update skip locked
       )
       update outbox_events o
       set status = 'publishing',
           lease_token = gen_random_uuid(),
           lease_expires_at = now() + (? * interval '1 millisecond'),
           dispatch_count = o.dispatch_count + 1,
           updated_at = now()
       from candidates c, deliveries d
       where o.id = c.id and d.tenant_id = o.tenant_id and d.id = o.delivery_id
       returning o.id, o.delivery_id, o.generation, d.channel, o.dispatch_count, o.lease_token,
                 o.available_at`,
      [limit, leaseMs],
    );
    return claimed
      .sort((a, b) => toDate(a.available_at).getTime() - toDate(b.available_at).getTime())
      .map((row) => ({
        id: toId(row.id),
        deliveryId: toId(row.delivery_id),
        generation: num(row.generation),
        channel: str(row.channel) as Channel,
        dispatchCount: num(row.dispatch_count),
        leaseToken: str(row.lease_token),
      }));
  }

  async markPublished(id: number, leaseToken: string): Promise<boolean> {
    if (!isId(id) || !isUuid(leaseToken)) return false;
    const em = forkEm(this.orm);
    const result = await em.execute<QueryResult>(
      `update outbox_events
       set status = 'published', published_at = now(), lease_token = null,
           lease_expires_at = null, last_error = null, updated_at = now()
       where id = ? and lease_token = ? and status = 'publishing'`,
      [id, leaseToken],
      'run',
    );
    return result.affectedRows === 1;
  }

  async releaseAfterError(
    id: number,
    leaseToken: string,
    technicalError: string,
    retryAfterMs: number,
  ): Promise<boolean> {
    if (!isId(id) || !isUuid(leaseToken)) return false;
    const em = forkEm(this.orm);
    const result = await em.execute<QueryResult>(
      `update outbox_events
       set status = 'pending', available_at = now() + (? * interval '1 millisecond'),
           lease_token = null, lease_expires_at = null, last_error = ?, updated_at = now()
       where id = ? and lease_token = ? and status = 'publishing'`,
      [Math.max(0, Math.round(retryAfterMs)), technicalError.slice(0, 2000), id, leaseToken],
      'run',
    );
    return result.affectedRows === 1;
  }

  /**
   * Published events whose job may have been lost: the delivery is still runnable for the same
   * generation, is due, has no active lease and nothing happened for `olderThanMs`.
   */
  async findLostPublications(
    olderThanMs: number,
    limit: number,
  ): Promise<LostPublicationCandidate[]> {
    const rows = await forkEm(this.orm).execute<Row[]>(
      `select o.id, o.delivery_id, d.channel, o.dispatch_count
       from outbox_events o
       join deliveries d on d.tenant_id = o.tenant_id and d.id = o.delivery_id
       where ${LOST_CONDITION}
       order by o.published_at
       limit ?`,
      [olderThanMs, limit],
    );
    return rows.map((row) => ({
      id: toId(row.id),
      deliveryId: toId(row.delivery_id),
      channel: str(row.channel) as Channel,
      dispatchCount: num(row.dispatch_count),
    }));
  }

  /**
   * Candidates still lost with the same dispatch count go back to 'pending' (due now); the next
   * claim increments dispatch_count, yielding a new BullMQ job id. Conditions are re-checked
   * under the row lock, so a candidate processed meanwhile is left alone.
   */
  async rearmPublications(candidates: readonly LostPublicationCandidate[]): Promise<number> {
    const valid = candidates.filter((candidate) => isId(candidate.id));
    if (valid.length === 0) return 0;
    const em = forkEm(this.orm);
    const result = await em.execute<QueryResult>(
      `with wanted as (
         select (w->>'id')::bigint as id, (w->>'dispatchCount')::int as dispatch_count
         from jsonb_array_elements(?::jsonb) w
       ), lost as (
         select o.id from outbox_events o
         join wanted w on w.id = o.id and w.dispatch_count = o.dispatch_count
         join deliveries d on d.tenant_id = o.tenant_id and d.id = o.delivery_id
         where ${LOST_CONDITION_NOW}
         for update of o skip locked
       )
       update outbox_events o
       set status = 'pending', available_at = now(), updated_at = now()
       from lost
       where o.id = lost.id`,
      [JSON.stringify(valid.map(({ id, dispatchCount }) => ({ id, dispatchCount })))],
      'run',
    );
    return result.affectedRows;
  }
}

/** Runnable, due, unleased delivery of the same generation (database clock). */
const LOST_CONDITION_NOW = `o.status = 'published'
           and d.generation = o.generation
           and d.submission_status in ('pending', 'retry_wait')
           and (d.lease_token is null or d.lease_expires_at <= now())
           and (d.next_attempt_at is null or d.next_attempt_at <= now())`;

const LOST_CONDITION = `${LOST_CONDITION_NOW}
         and o.published_at <= now() - (? * interval '1 millisecond')`;
