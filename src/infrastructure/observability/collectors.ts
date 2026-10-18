import { forkEm, num, type Orm, type Row } from '../database/sql-support.js';
import { METRIC_PREFIX, shareSample, type PrometheusMetrics } from './prometheus-metrics.js';

// ---------------------------------------------------------------- Outbox backlog

export interface OutboxBacklog {
  /** Events not yet published (`pending` + `publishing`). */
  pending: number;
  /**
   * Seconds since the oldest *due* unpublished event became available (`now() - available_at`),
   * 0 when none is due. Events deferred to the future (publication retry backoff) do not count.
   */
  oldestAgeSeconds: number;
}

/** One statement, served by `outbox_events_available_index` (partial on unpublished rows). */
export const OUTBOX_BACKLOG_SQL = `select count(*)::int as pending,
  coalesce(extract(epoch from (now() - min(available_at) filter (where available_at <= now()))), 0)::float8
    as oldest_age_seconds
from outbox_events
where status <> 'published'`;

export async function queryOutboxBacklog(orm: Orm): Promise<OutboxBacklog> {
  const rows = await forkEm(orm).execute<Row[]>(OUTBOX_BACKLOG_SQL);
  const row = rows[0];
  return {
    pending: num(row?.pending ?? 0),
    oldestAgeSeconds: Math.max(0, num(row?.oldest_age_seconds ?? 0)),
  };
}

export function registerOutboxCollector(
  metrics: PrometheusMetrics,
  sample: () => Promise<OutboxBacklog>,
): void {
  const shared = shareSample(sample);
  metrics.registerPullGauge(
    `${METRIC_PREFIX}outbox_pending_events`,
    'Outbox events not yet published.',
    [],
    async () => [{ value: (await shared()).pending }],
  );
  metrics.registerPullGauge(
    `${METRIC_PREFIX}outbox_oldest_pending_age_seconds`,
    'Seconds since the oldest due unpublished outbox event became available.',
    [],
    async () => [{ value: (await shared()).oldestAgeSeconds }],
  );
}

// ---------------------------------------------------------------- Valkey memory

/** Structural subset of an ioredis client. */
export interface InfoClient {
  info(section: string): Promise<string>;
}

export interface ValkeyMemory {
  usedBytes: number;
  /** 0 means no limit configured. */
  maxBytes: number;
}

/** Parses the `key:value` lines of an `INFO` reply. */
export function parseInfo(reply: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of reply.split(/\r?\n/)) {
    if (line === '' || line.startsWith('#')) continue;
    const at = line.indexOf(':');
    if (at > 0) fields.set(line.slice(0, at), line.slice(at + 1).trim());
  }
  return fields;
}

export async function readValkeyMemory(client: InfoClient): Promise<ValkeyMemory> {
  const fields = parseInfo(await client.info('memory'));
  const used = Number(fields.get('used_memory'));
  const max = Number(fields.get('maxmemory') ?? 0);
  if (!Number.isFinite(used)) throw new Error('INFO memory reply has no used_memory');
  return { usedBytes: used, maxBytes: Number.isFinite(max) ? max : 0 };
}

export function registerValkeyMemoryCollector(
  metrics: PrometheusMetrics,
  client: InfoClient,
): void {
  const shared = shareSample(() => readValkeyMemory(client));
  metrics.registerPullGauge(
    `${METRIC_PREFIX}valkey_memory_used_bytes`,
    'Valkey used_memory (INFO memory).',
    [],
    async () => [{ value: (await shared()).usedBytes }],
  );
  metrics.registerPullGauge(
    `${METRIC_PREFIX}valkey_memory_max_bytes`,
    'Valkey maxmemory (INFO memory); 0 means unlimited.',
    [],
    async () => [{ value: (await shared()).maxBytes }],
  );
}

// ---------------------------------------------------------------- DB connection pool

export interface DbPoolStats {
  /** Connections checked out by queries/transactions. */
  inUse: number;
  idle: number;
  /** Acquire requests queued because the pool is exhausted. */
  waiting: number;
  max: number;
}

/** Public counters of `pg-pool` (the pool MikroORM 7's PostgreSQL driver creates). */
interface PgPoolCounters {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}

function isPgPool(value: unknown): value is PgPoolCounters {
  if (typeof value !== 'object' || value === null) return false;
  const pool = value as Record<string, unknown>;
  return (
    typeof pool.totalCount === 'number' &&
    typeof pool.idleCount === 'number' &&
    typeof pool.waitingCount === 'number'
  );
}

/**
 * Reads the `pg` pool behind the ORM (`PostgreSqlConnection.getNativeClient()`). `max` comes from
 * configuration (`DATABASE_POOL_MAX`), the same value passed to the driver.
 */
export function ormPoolStats(orm: Orm, max: number): () => Promise<DbPoolStats> {
  return async () => {
    const pool: unknown = await orm.em.getConnection().getNativeClient();
    if (!isPgPool(pool)) throw new Error('database pool counters are not available');
    return {
      inUse: Math.max(0, pool.totalCount - pool.idleCount),
      idle: pool.idleCount,
      waiting: pool.waitingCount,
      max,
    };
  };
}

export function registerDbPoolCollector(
  metrics: PrometheusMetrics,
  sample: () => Promise<DbPoolStats>,
): void {
  const shared = shareSample(sample);
  metrics.registerPullGauge(
    `${METRIC_PREFIX}db_pool_connections`,
    'Database pool connections, by state.',
    ['state'],
    async () => {
      const stats = await shared();
      return [
        { labels: { state: 'in_use' }, value: stats.inUse },
        { labels: { state: 'idle' }, value: stats.idle },
      ];
    },
  );
  metrics.registerPullGauge(
    `${METRIC_PREFIX}db_pool_max_connections`,
    'Configured maximum size of the database pool.',
    [],
    async () => [{ value: (await shared()).max }],
  );
  metrics.registerPullGauge(
    `${METRIC_PREFIX}db_pool_waiting_requests`,
    'Connection requests waiting for a free pool connection.',
    [],
    async () => [{ value: (await shared()).waiting }],
  );
  metrics.registerPullGauge(
    `${METRIC_PREFIX}db_pool_saturation_ratio`,
    'Database pool connections in use divided by the pool maximum.',
    [],
    async () => {
      const stats = await shared();
      return stats.max > 0 ? [{ value: stats.inUse / stats.max }] : [];
    },
  );
}

// ---------------------------------------------------------------- BullMQ queue depth

export const QUEUE_JOB_STATES = ['waiting', 'active', 'delayed', 'failed'] as const;

/** Structural subset of a BullMQ `Queue`. */
export interface JobCountsSource {
  readonly name: string;
  getJobCounts(...types: string[]): Promise<Record<string, number>>;
}

export function registerQueueDepthCollector(
  metrics: PrometheusMetrics,
  queues: readonly JobCountsSource[],
): void {
  metrics.registerPullGauge(
    `${METRIC_PREFIX}queue_jobs`,
    'BullMQ jobs, by queue and state.',
    ['queue', 'state'],
    async () => {
      const perQueue = await Promise.all(
        queues.map(async (queue) => ({
          queue: queue.name,
          counts: await queue.getJobCounts(...QUEUE_JOB_STATES),
        })),
      );
      return perQueue.flatMap(({ queue, counts }) =>
        QUEUE_JOB_STATES.map((state) => ({ labels: { queue, state }, value: counts[state] ?? 0 })),
      );
    },
  );
}
