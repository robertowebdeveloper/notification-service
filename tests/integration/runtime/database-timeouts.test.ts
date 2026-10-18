import {
  type AddressInfo,
  type Server,
  type Socket,
  createConnection,
  createServer,
} from 'node:net';
import type { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL } from '../infra/test-env.js';
import { databaseUrl, initOrm } from './support.js';

/** TCP proxy to PostgreSQL that can silently stop forwarding bytes (sockets stay open). */
class BlackholeProxy {
  blackholed = false;
  private readonly sockets = new Set<Socket>();
  private readonly server: Server;

  constructor(upstreamHost: string, upstreamPort: number) {
    this.server = createServer((downstream) => {
      const upstream = createConnection({ host: upstreamHost, port: upstreamPort });
      for (const socket of [downstream, upstream]) {
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
        socket.on('error', () => socket.destroy());
      }
      downstream.on('data', (chunk) => {
        if (!this.blackholed) upstream.write(chunk);
      });
      upstream.on('data', (chunk) => {
        if (!this.blackholed) downstream.write(chunk);
      });
      downstream.on('close', () => upstream.destroy());
      upstream.on('close', () => downstream.destroy());
    });
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => {
      this.server.listen(0, '127.0.0.1', resolve);
    });
    return (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }
}

async function elapsed<T>(work: Promise<T>): Promise<{ ms: number; error: unknown }> {
  const started = performance.now();
  try {
    await work;
    return { ms: performance.now() - started, error: undefined };
  } catch (error) {
    return { ms: performance.now() - started, error };
  }
}

describe('PostgreSQL timeouts (orm-config)', () => {
  const upstream = new URL(TEST_DATABASE_URL);
  const proxy = new BlackholeProxy(upstream.hostname, Number(upstream.port || 5432));
  let orm: MikroORM;

  beforeAll(async () => {
    const port = await proxy.listen();
    orm = await initOrm(databaseUrl({ host: '127.0.0.1', port }), {
      // A single client: a poisoned connection would be handed out again.
      poolMax: 1,
      timeouts: { connectTimeoutMs: 1000, statementTimeoutMs: 500, queryTimeoutMs: 1500 },
    });
  });

  afterAll(async () => {
    proxy.blackholed = false;
    await orm.close(true);
    await proxy.close();
  });

  const ping = () => orm.em.fork().execute<{ ok: number }[]>('select 1 as ok');

  it('cancels a slow statement server-side and keeps the connection usable', async () => {
    const { ms, error } = await elapsed(orm.em.fork().execute('select pg_sleep(5)'));
    expect(error).toMatchObject({ code: '57014' });
    expect(ms).toBeLessThan(3000);
    expect(await ping()).toEqual([{ ok: 1 }]);
  });

  it('fails a query on a blackholed connection within the timeout and recovers afterwards', async () => {
    expect(await ping()).toEqual([{ ok: 1 }]);
    proxy.blackholed = true;

    const stuck = await elapsed(ping());
    expect(String(stuck.error)).toMatch(/Query read timeout/);
    expect(stuck.ms).toBeGreaterThanOrEqual(1400);
    expect(stuck.ms).toBeLessThan(4000);

    // The timed-out client was discarded: a new one cannot even connect through the blackhole.
    const reconnect = await elapsed(ping());
    expect(reconnect.error).toBeDefined();
    expect(reconnect.ms).toBeLessThan(4000);

    proxy.blackholed = false;
    expect(await ping()).toEqual([{ ok: 1 }]);
  });
});
