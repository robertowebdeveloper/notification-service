import { afterEach, describe, expect, it } from 'vitest';
import {
  startOpsServer,
  type OpsServer,
  type OpsServerOptions,
} from '../../../src/infrastructure/observability/ops-server.js';
import { PrometheusMetrics } from '../../../src/infrastructure/observability/prometheus-metrics.js';

let server: OpsServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(options: Partial<OpsServerOptions> = {}): Promise<string> {
  server = await startOpsServer({ host: '127.0.0.1', port: 0, ...options });
  return `http://127.0.0.1:${server.address.port}`;
}

describe('ops server', () => {
  it('serves Prometheus text on /metrics', async () => {
    const metrics = new PrometheusMetrics({ service: 'worker', defaultMetrics: false });
    metrics.outboxPublished(2);
    const base = await start({ metrics });

    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toContain('notifications_outbox_published_total{service="worker"} 2');
  });

  it('answers liveness without dependencies', async () => {
    const base = await start();
    const res = await fetch(`${base}/health/live`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('returns 200 with the readiness body when ready', async () => {
    const base = await start({
      readiness: () => Promise.resolve({ ready: true, checks: { database: true, valkey: true } }),
    });
    const res = await fetch(`${base}/health/ready`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ready: true, checks: { database: true, valkey: true } });
  });

  it('returns 503 when a dependency is not ready', async () => {
    const base = await start({
      readiness: () => Promise.resolve({ ready: false, checks: { database: true, valkey: false } }),
    });
    const res = await fetch(`${base}/health/ready`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ready: false, checks: { database: true, valkey: false } });
  });

  it('returns 503 when the readiness check throws or times out', async () => {
    const base = await start({ readiness: () => Promise.reject(new Error('boom')) });
    expect((await fetch(`${base}/health/ready`)).status).toBe(503);
    await server?.close();

    const slow = await start({
      readiness: () => new Promise(() => undefined),
      readinessTimeoutMs: 20,
    });
    const res = await fetch(`${slow}/health/ready`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ready: false, checks: {} });
  });

  it('returns 404 for unknown paths, other methods and unconfigured routes', async () => {
    const base = await start();
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/v1/notifications`)).status).toBe(404);
    expect((await fetch(`${base}/metrics`)).status).toBe(404);
    expect((await fetch(`${base}/health/ready`)).status).toBe(404);
    expect((await fetch(`${base}/health/live`, { method: 'POST' })).status).toBe(404);
  });

  it('ignores query strings when routing', async () => {
    const base = await start();
    expect((await fetch(`${base}/health/live?probe=1`)).status).toBe(200);
  });

  it('answers 500 when the metrics scrape fails', async () => {
    const base = await start({
      metrics: { contentType: 'text/plain', scrape: () => Promise.reject(new Error('x')) },
    });
    expect((await fetch(`${base}/metrics`)).status).toBe(500);
  });

  it('closes idempotently and stops accepting connections', async () => {
    const base = await start();
    await fetch(`${base}/health/live`);
    const current = server;
    await Promise.all([current?.close(), current?.close()]);
    server = undefined;
    await expect(fetch(`${base}/health/live`)).rejects.toThrow();
  });
});
