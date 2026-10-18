import type { MikroORM } from '@mikro-orm/postgresql';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgNotificationRepository } from '../../../src/infrastructure/database/notification-repository.js';
import {
  ormPoolStats,
  queryOutboxBacklog,
  readValkeyMemory,
  registerOutboxCollector,
  registerValkeyMemoryCollector,
} from '../../../src/infrastructure/observability/collectors.js';
import { PrometheusMetrics } from '../../../src/infrastructure/observability/prometheus-metrics.js';
import {
  closeOrm,
  createTenantFixture,
  deliveryIdOf,
  migratedOrm,
  notificationInput,
  queryRows,
  truncateAll,
} from '../database/support.js';

const VALKEY_URL = process.env.TEST_OBSERVABILITY_VALKEY_URL ?? 'redis://localhost:6379/4';

describe('outbox backlog query', () => {
  let orm: MikroORM;
  let notifications: PgNotificationRepository;

  beforeAll(async () => {
    orm = await migratedOrm();
    notifications = new PgNotificationRepository(orm);
  });

  beforeEach(async () => {
    await truncateAll(orm);
  });

  afterAll(closeOrm);

  async function seed(): Promise<string> {
    const fixture = await createTenantFixture(orm);
    const result = await notifications.create(notificationInput(fixture));
    if (result.kind !== 'created') throw new Error('expected created');
    return deliveryIdOf(orm, result.notificationId);
  }

  it('reports zero on an empty outbox', async () => {
    expect(await queryOutboxBacklog(orm)).toEqual({ pending: 0, oldestAgeSeconds: 0 });
  });

  it('measures the oldest due unpublished event and ignores published or future ones', async () => {
    const [due, future, published] = [await seed(), await seed(), await seed()];
    await queryRows(
      orm,
      `update outbox_events set available_at = now() - interval '90 seconds' where delivery_id = ?`,
      [due],
    );
    await queryRows(
      orm,
      `update outbox_events set available_at = now() + interval '1 hour' where delivery_id = ?`,
      [future],
    );
    await queryRows(
      orm,
      `update outbox_events set status = 'published', published_at = now(),
         available_at = now() - interval '1 day' where delivery_id = ?`,
      [published],
    );

    const backlog = await queryOutboxBacklog(orm);
    expect(backlog.pending).toBe(2);
    expect(backlog.oldestAgeSeconds).toBeGreaterThanOrEqual(89);
    expect(backlog.oldestAgeSeconds).toBeLessThan(120);
  });

  it('feeds the outbox gauges and the pool gauges at scrape time', async () => {
    await seed();
    const metrics = new PrometheusMetrics({ service: 'dispatcher', defaultMetrics: false });
    registerOutboxCollector(metrics, () => queryOutboxBacklog(orm));
    const stats = await ormPoolStats(orm, 10)();
    expect(stats.max).toBe(10);
    expect(stats.inUse + stats.idle).toBeGreaterThanOrEqual(0);

    const text = await metrics.scrape();
    expect(text).toContain('notifications_outbox_pending_events{service="dispatcher"} 1');
    expect(text).toMatch(
      /^notifications_outbox_oldest_pending_age_seconds\{service="dispatcher"\} /m,
    );
  });
});

describe('valkey memory collector', () => {
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis(VALKEY_URL, { maxRetriesPerRequest: 1 });
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('reads used_memory and maxmemory from a real Valkey', async () => {
    const memory = await readValkeyMemory(redis);
    expect(memory.usedBytes).toBeGreaterThan(0);
    expect(memory.maxBytes).toBeGreaterThanOrEqual(0);

    const metrics = new PrometheusMetrics({ service: 'worker', defaultMetrics: false });
    registerValkeyMemoryCollector(metrics, redis);
    expect(await metrics.scrape()).toMatch(
      /^notifications_valkey_memory_used_bytes\{service="worker"\} [1-9]\d*$/m,
    );
  });

  it('skips the samples when Valkey is unreachable', async () => {
    const down = new Redis('redis://127.0.0.1:1/4', {
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
      lazyConnect: true,
    });
    down.on('error', () => undefined);
    const metrics = new PrometheusMetrics({ service: 'worker', defaultMetrics: false });
    registerValkeyMemoryCollector(metrics, down);
    const text = await metrics.scrape();
    expect(text).toContain('# TYPE notifications_valkey_memory_used_bytes gauge');
    expect(text).not.toMatch(/^notifications_valkey_memory_used_bytes\{/m);
    down.disconnect();
  });
});
