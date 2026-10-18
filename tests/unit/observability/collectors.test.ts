import { describe, expect, it, vi } from 'vitest';
import {
  ormPoolStats,
  parseInfo,
  readValkeyMemory,
  registerDbPoolCollector,
  registerOutboxCollector,
  registerQueueDepthCollector,
  registerValkeyMemoryCollector,
} from '../../../src/infrastructure/observability/collectors.js';
import { PrometheusMetrics } from '../../../src/infrastructure/observability/prometheus-metrics.js';
import type { Orm } from '../../../src/infrastructure/database/sql-support.js';

const INFO = '# Memory\r\nused_memory:1048576\r\nused_memory_human:1.00M\r\nmaxmemory:0\r\n';

function metrics() {
  return new PrometheusMetrics({ service: 'dispatcher', defaultMetrics: false });
}

describe('valkey memory collector', () => {
  it('parses INFO memory', async () => {
    expect(parseInfo(INFO).get('used_memory_human')).toBe('1.00M');
    expect(await readValkeyMemory({ info: () => Promise.resolve(INFO) })).toEqual({
      usedBytes: 1048576,
      maxBytes: 0,
    });
    await expect(
      readValkeyMemory({ info: () => Promise.resolve('# Memory\r\n') }),
    ).rejects.toThrow();
  });

  it('issues one INFO per scrape for both gauges', async () => {
    const m = metrics();
    const info = vi.fn(() => Promise.resolve(INFO));
    registerValkeyMemoryCollector(m, { info });
    const text = await m.scrape();
    expect(text).toContain('notifications_valkey_memory_used_bytes{service="dispatcher"} 1048576');
    expect(text).toContain('notifications_valkey_memory_max_bytes{service="dispatcher"} 0');
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('memory');
  });

  it('drops the samples but keeps the scrape alive when Valkey is down', async () => {
    const m = metrics();
    registerValkeyMemoryCollector(m, { info: () => Promise.reject(new Error('ECONNREFUSED')) });
    m.outboxPublished(1);
    const text = await m.scrape();
    expect(text).not.toMatch(/^notifications_valkey_memory_used_bytes\{/m);
    expect(text).toContain('notifications_outbox_published_total{service="dispatcher"} 1');
  });
});

describe('outbox collector', () => {
  it('exposes pending count and oldest age from one sample', async () => {
    const m = metrics();
    const sample = vi.fn(() => Promise.resolve({ pending: 12, oldestAgeSeconds: 3.5 }));
    registerOutboxCollector(m, sample);
    const text = await m.scrape();
    expect(text).toContain('notifications_outbox_pending_events{service="dispatcher"} 12');
    expect(text).toContain(
      'notifications_outbox_oldest_pending_age_seconds{service="dispatcher"} 3.5',
    );
    expect(sample).toHaveBeenCalledTimes(1);
  });
});

describe('db pool collector', () => {
  it('reads pg-pool counters through the ORM connection', async () => {
    const pool = { totalCount: 7, idleCount: 2, waitingCount: 3 };
    const orm = {
      em: { getConnection: () => ({ getNativeClient: () => Promise.resolve(pool) }) },
    } as unknown as Orm;
    const m = metrics();
    registerDbPoolCollector(m, ormPoolStats(orm, 10));
    const text = await m.scrape();
    expect(text).toContain(
      'notifications_db_pool_connections{state="in_use",service="dispatcher"} 5',
    );
    expect(text).toContain(
      'notifications_db_pool_connections{state="idle",service="dispatcher"} 2',
    );
    expect(text).toContain('notifications_db_pool_max_connections{service="dispatcher"} 10');
    expect(text).toContain('notifications_db_pool_waiting_requests{service="dispatcher"} 3');
    expect(text).toContain('notifications_db_pool_saturation_ratio{service="dispatcher"} 0.5');
  });

  it('skips samples when the driver exposes no pool counters', async () => {
    const orm = {
      em: { getConnection: () => ({ getNativeClient: () => Promise.resolve({}) }) },
    } as unknown as Orm;
    await expect(ormPoolStats(orm, 10)()).rejects.toThrow('not available');
  });
});

describe('queue depth collector', () => {
  it('labels job counts by queue and state', async () => {
    const getJobCounts = vi.fn(() =>
      Promise.resolve({ waiting: 4, active: 1, delayed: 2, failed: 0 }),
    );
    const m = metrics();
    registerQueueDepthCollector(m, [{ name: 'deliveries-email', getJobCounts }]);
    const text = await m.scrape();
    expect(getJobCounts).toHaveBeenCalledWith('waiting', 'active', 'delayed', 'failed');
    expect(text).toContain(
      'notifications_queue_jobs{queue="deliveries-email",state="waiting",service="dispatcher"} 4',
    );
    expect(text).toContain(
      'notifications_queue_jobs{queue="deliveries-email",state="failed",service="dispatcher"} 0',
    );
  });
});
