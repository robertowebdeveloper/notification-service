import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closeOrm, migratedOrm, TEST_DATABASE_URL } from '../database/support.js';

const VALKEY_URL = process.env.TEST_OBSERVABILITY_VALKEY_URL ?? 'redis://localhost:6379/4';
const STARTUP_MS = 25_000;

interface Running {
  child: ChildProcess;
  output: string[];
  exited: Promise<number | null>;
}

const children: Running[] = [];

async function freePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, 'close');
  return port;
}

function start(entry: string, env: Record<string, string>): Running {
  const child = spawn(process.execPath, ['--import', 'tsx', `src/entrypoints/${entry}.ts`], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? '',
      APP_ENV: 'test',
      LOG_LEVEL: 'info',
      DATABASE_URL: TEST_DATABASE_URL,
      VALKEY_URL,
      OPS_HOST: '127.0.0.1',
      SHUTDOWN_GRACE_MS: '10000',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output: string[] = [];
  child.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => {
      resolve(code);
    });
  });
  const running = { child, output, exited };
  children.push(running);
  return running;
}

async function waitForHttp(url: string, running: Running): Promise<Response> {
  const deadline = Date.now() + STARTUP_MS;
  for (;;) {
    if (running.child.exitCode !== null) {
      throw new Error(`process exited early:\n${running.output.join('')}`);
    }
    try {
      return await fetch(url);
    } catch {
      if (Date.now() > deadline)
        throw new Error(`no answer from ${url}:\n${running.output.join('')}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

async function stop(running: Running): Promise<number | null> {
  running.child.kill('SIGTERM');
  return running.exited;
}

describe('entrypoint ops servers', () => {
  beforeAll(async () => {
    // Applies the migrations to notifications_test before the processes connect.
    await migratedOrm();
  });

  afterEach(() => {
    for (const running of children.splice(0)) {
      if (running.child.exitCode === null) running.child.kill('SIGKILL');
    }
  });

  afterAll(async () => {
    await closeOrm();
    const redis = new Redis(VALKEY_URL, { maxRetriesPerRequest: 1 });
    await redis.flushdb();
    await redis.quit();
  });

  it('api exposes /metrics on OPS_PORT and keeps health on the public port', async () => {
    const [httpPort, opsPort] = [await freePort(), await freePort()];
    const api = start('api', { HTTP_PORT: String(httpPort), OPS_PORT: String(opsPort) });

    const metrics = await waitForHttp(`http://127.0.0.1:${opsPort}/metrics`, api);
    expect(metrics.status).toBe(200);
    const text = await metrics.text();
    expect(text).toContain(
      'notifications_api_requests_accepted_total{operation="create_notification",service="api"} 0',
    );
    expect(text).toMatch(/^notifications_db_pool_max_connections\{service="api"\} 10$/m);
    expect((await fetch(`http://127.0.0.1:${opsPort}/health/ready`)).status).toBe(404);
    const health = await waitForHttp(`http://127.0.0.1:${httpPort}/health/ready`, api);
    expect(health.status).toBe(200);

    expect(await stop(api)).toBe(0);
  });

  it('worker answers /metrics and /health/ready, then exits 0 on SIGTERM', async () => {
    const opsPort = await freePort();
    const worker = start('worker', { OPS_PORT: String(opsPort) });

    const ready = await waitForHttp(`http://127.0.0.1:${opsPort}/health/ready`, worker);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({
      ready: true,
      checks: { database: true, valkey: true, jobs: true },
    });
    const text = await (await fetch(`http://127.0.0.1:${opsPort}/metrics`)).text();
    expect(text).toMatch(/^notifications_valkey_memory_used_bytes\{service="worker"\} [1-9]/m);
    expect(text).toMatch(
      /^notifications_queue_jobs\{queue="[^"]+",state="waiting",service="worker"\} \d+$/m,
    );
    expect(worker.output.join('')).toContain('worker started');

    expect(await stop(worker)).toBe(0);
  });

  it('dispatcher answers /metrics and /health/ready, then exits 0 on SIGTERM', async () => {
    const opsPort = await freePort();
    const dispatcher = start('dispatcher', { OPS_PORT: String(opsPort) });

    const ready = await waitForHttp(`http://127.0.0.1:${opsPort}/health/ready`, dispatcher);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({
      ready: true,
      checks: { database: true, valkey: true, loops: true },
    });
    const text = await (await fetch(`http://127.0.0.1:${opsPort}/metrics`)).text();
    expect(text).toMatch(/^notifications_outbox_pending_events\{service="dispatcher"\} \d+$/m);
    expect(text).toMatch(
      /^notifications_db_pool_connections\{state="in_use",service="dispatcher"\} \d+$/m,
    );
    expect(text).toMatch(/^notifications_valkey_memory_used_bytes\{service="dispatcher"\} [1-9]/m);
    expect(dispatcher.output.join('')).toContain('dispatcher started');

    expect(await stop(dispatcher)).toBe(0);
  });

  it('exits 1 with a clear message when OPS_PORT is busy, before consuming jobs', async () => {
    const blocker = createServer().listen(0, '127.0.0.1');
    await once(blocker, 'listening');
    const busy = (blocker.address() as AddressInfo).port;
    try {
      const worker = start('worker', { OPS_PORT: String(busy) });
      expect(await worker.exited).toBe(1);
      const output = worker.output.join('');
      expect(output).toContain(
        `ops server cannot listen on 127.0.0.1:${busy}: address already in use`,
      );
      expect(output).not.toContain('worker started');
    } finally {
      blocker.close();
    }
  });
});
