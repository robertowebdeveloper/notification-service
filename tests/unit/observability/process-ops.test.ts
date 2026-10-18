import { createServer, type Server } from 'node:net';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  dependencyReadiness,
  OpsServerStartError,
  startProcessOps,
} from '../../../src/infrastructure/observability/process-ops.js';
import { PrometheusMetrics } from '../../../src/infrastructure/observability/prometheus-metrics.js';

const logger = { warn: () => undefined, debug: () => undefined };
let blocker: Server | undefined;

afterEach(async () => {
  if (blocker) {
    blocker.close();
    await once(blocker, 'close');
    blocker = undefined;
  }
});

describe('startProcessOps', () => {
  it('fails with a clear error when OPS_PORT is already in use', async () => {
    blocker = createServer().listen(0, '127.0.0.1');
    await once(blocker, 'listening');
    const port = (blocker.address() as AddressInfo).port;
    const metrics = new PrometheusMetrics({ service: 'worker', defaultMetrics: false });

    const started = startProcessOps({
      config: { OPS_HOST: '127.0.0.1', OPS_PORT: port },
      metrics,
      logger,
    });
    await expect(started).rejects.toBeInstanceOf(OpsServerStartError);
    await expect(started).rejects.toThrow(
      `ops server cannot listen on 127.0.0.1:${port}: address already in use`,
    );
  });

  it('serves metrics and readiness on the configured address', async () => {
    const metrics = new PrometheusMetrics({ service: 'dispatcher', defaultMetrics: false });
    const ops = await startProcessOps({
      config: { OPS_HOST: '127.0.0.1', OPS_PORT: 0 },
      metrics,
      logger,
      readiness: dependencyReadiness({ database: () => Promise.resolve(true) }),
    });
    try {
      const base = `http://127.0.0.1:${ops.address.port}`;
      expect(await (await fetch(`${base}/metrics`)).text()).toContain('service="dispatcher"');
      expect(await (await fetch(`${base}/health/ready`)).json()).toEqual({
        ready: true,
        checks: { database: true },
      });
    } finally {
      await ops.close();
    }
  });
});

describe('dependencyReadiness', () => {
  it('is ready only when every check passes; a throwing check is not ready', async () => {
    const readiness = dependencyReadiness({
      database: () => Promise.resolve(true),
      valkey: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    expect(await readiness()).toEqual({ ready: false, checks: { database: true, valkey: false } });
    expect(await dependencyReadiness({ database: () => Promise.resolve(true) })()).toEqual({
      ready: true,
      checks: { database: true },
    });
  });
});
