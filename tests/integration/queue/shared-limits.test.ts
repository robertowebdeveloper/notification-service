import { randomInt } from 'node:crypto';

/** Unique provider instance id per test (keys are shared in Valkey). */
const anyInstanceId = () => randomInt(1, 2 ** 47);
import type { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { ValkeyCircuitBreaker } from '../../../src/infrastructure/queue/circuit-breaker.js';
import { ValkeyTokenBucketRateLimiter } from '../../../src/infrastructure/queue/rate-limiter.js';
import { createProducerConnection } from '../../../src/infrastructure/queue/valkey-connection.js';
import { ready, TEST_VALKEY_URL, uniqueSuffix } from '../infra/test-env.js';

const connections: Redis[] = [];

async function connect(url = TEST_VALKEY_URL): Promise<Redis> {
  const connection = createProducerConnection(url);
  connection.on('error', () => undefined);
  connections.push(connection);
  if (url === TEST_VALKEY_URL) await ready(connection);
  return connection;
}

afterAll(async () => {
  for (const connection of connections) connection.disconnect();
  const cleanup = createProducerConnection(TEST_VALKEY_URL);
  await ready(cleanup);
  const keys = await cleanup.keys('ns-test:*');
  if (keys.length > 0) await cleanup.del(...keys);
  await cleanup.quit();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('ValkeyTokenBucketRateLimiter', () => {
  it('shares one bucket per provider instance across limiter clients', async () => {
    const prefix = `ns-test:rl:${uniqueSuffix()}`;
    const limit = { burst: 3, perSecond: 0.01 };
    const a = new ValkeyTokenBucketRateLimiter(await connect(), { prefix, defaultLimit: limit });
    const b = new ValkeyTokenBucketRateLimiter(await connect(), { prefix, defaultLimit: limit });
    const instance = anyInstanceId();

    const decisions = await Promise.all(
      Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? a : b).tryAcquire(instance)),
    );
    expect(decisions.filter((d) => d.allowed)).toHaveLength(3);
    const denied = decisions.find((d) => !d.allowed);
    expect(denied).toMatchObject({ allowed: false });
    expect(denied?.allowed === false ? denied.retryAfterMs : 0).toBeGreaterThan(1_000);

    // Other instances have their own bucket.
    expect(await a.tryAcquire(anyInstanceId())).toEqual({ allowed: true });
  });

  it('refills over time', async () => {
    const prefix = `ns-test:rl:${uniqueSuffix()}`;
    const limiter = new ValkeyTokenBucketRateLimiter(await connect(), {
      prefix,
      defaultLimit: { burst: 1, perSecond: 20 },
    });
    const instance = anyInstanceId();
    expect((await limiter.tryAcquire(instance)).allowed).toBe(true);
    expect((await limiter.tryAcquire(instance)).allowed).toBe(false);
    await sleep(120);
    expect((await limiter.tryAcquire(instance)).allowed).toBe(true);
  });

  it('applies a per-instance override instead of the default limit', async () => {
    const prefix = `ns-test:rl:${uniqueSuffix()}`;
    const limiter = new ValkeyTokenBucketRateLimiter(await connect(), {
      prefix,
      defaultLimit: { burst: 1, perSecond: 0.01 },
    });
    const overridden = anyInstanceId();
    const override = { burst: 3, perSecond: 0.01 };
    const decisions = [];
    for (let i = 0; i < 4; i += 1) decisions.push(await limiter.tryAcquire(overridden, override));
    expect(decisions.map((d) => d.allowed)).toEqual([true, true, true, false]);

    const defaulted = anyInstanceId();
    expect((await limiter.tryAcquire(defaulted)).allowed).toBe(true);
    expect((await limiter.tryAcquire(defaulted)).allowed).toBe(false);
  });

  it('throws within a bounded time when Valkey is unreachable', async () => {
    const limiter = new ValkeyTokenBucketRateLimiter(await connect('redis://127.0.0.1:1/1'), {
      commandTimeoutMs: 500,
    });
    const started = performance.now();
    await expect(limiter.tryAcquire(anyInstanceId())).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('ValkeyCircuitBreaker', () => {
  async function breaker(options: ConstructorParameters<typeof ValkeyCircuitBreaker>[1] = {}) {
    return new ValkeyCircuitBreaker(await connect(), {
      prefix: `ns-test:cb:${uniqueSuffix()}`,
      failureThreshold: 2,
      failureWindowMs: 10_000,
      openMs: 200,
      probeTtlMs: 5_000,
      ...options,
    });
  }

  it('opens after the threshold, then admits a single half-open probe', async () => {
    const cb = await breaker();
    const id = anyInstanceId();
    expect(await cb.acquire(id)).toEqual({ allowed: true, probe: false });
    await cb.recordFailure(id);
    expect((await cb.acquire(id)).allowed).toBe(true);
    await cb.recordFailure(id);
    expect(await cb.acquire(id)).toMatchObject({ allowed: false });

    await sleep(250);
    const permits = await Promise.all(Array.from({ length: 6 }, () => cb.acquire(id)));
    expect(permits.filter((p) => p.allowed)).toEqual([
      { allowed: true, probe: true, probeToken: expect.any(String) as unknown },
    ]);

    // Probe failure re-opens; probe success closes.
    await cb.recordFailure(id);
    expect((await cb.acquire(id)).allowed).toBe(false);
    await sleep(250);
    const probe = await cb.acquire(id);
    expect(probe).toMatchObject({ allowed: true, probe: true });
    await cb.recordSuccess(id, probe.allowed && probe.probe ? probe.probeToken : '');
    expect(await cb.acquire(id)).toEqual({ allowed: true, probe: false });
  });

  it('half-open: only the probe holder closes the breaker; an unused probe can be given back', async () => {
    const cb = await breaker();
    const id = anyInstanceId();
    await cb.recordFailure(id);
    await cb.recordFailure(id);
    await sleep(250);
    const probe = await cb.acquire(id);
    if (!probe.allowed || !probe.probe) throw new Error('expected the probe');

    // A late success of a call that started before the breaker opened changes nothing.
    await cb.recordSuccess(id);
    await cb.recordSuccess(id, 'not-the-probe');
    expect((await cb.acquire(id)).allowed).toBe(false);

    // Releasing with a wrong token is ignored; the holder's release admits a new probe at once.
    await cb.releaseProbe(id, 'not-the-probe');
    expect((await cb.acquire(id)).allowed).toBe(false);
    await cb.releaseProbe(id, probe.probeToken);
    const next = await cb.acquire(id);
    expect(next).toMatchObject({ allowed: true, probe: true });
    expect(next.allowed && next.probe ? next.probeToken : '').not.toBe(probe.probeToken);

    // The old token can no longer close it; the new holder can.
    await cb.recordSuccess(id, probe.probeToken);
    expect((await cb.acquire(id)).allowed).toBe(false);
    await cb.recordSuccess(id, next.allowed && next.probe ? next.probeToken : '');
    expect(await cb.acquire(id)).toEqual({ allowed: true, probe: false });
  });

  it('force-open (configuration quarantine) is not closed by a stray success', async () => {
    const cb = await breaker();
    const id = anyInstanceId();
    await cb.forceOpen(id, 60_000);
    await cb.recordSuccess(id);
    const permit = await cb.acquire(id);
    expect(permit.allowed).toBe(false);
    expect(permit.allowed ? 0 : permit.retryAfterMs).toBeGreaterThan(50_000);
  });

  it('uses per-instance overrides of threshold and open time', async () => {
    const cb = await breaker({ failureThreshold: 5, openMs: 60_000 });
    const id = anyInstanceId();
    await cb.recordFailure(id, { failureThreshold: 1, openMs: 200 });
    expect((await cb.acquire(id)).allowed).toBe(false);
    await sleep(250);
    expect(await cb.acquire(id)).toMatchObject({ allowed: true, probe: true });

    // The default threshold (5) still applies to instances without overrides.
    const other = anyInstanceId();
    await cb.recordFailure(other);
    await cb.recordFailure(other);
    expect((await cb.acquire(other)).allowed).toBe(true);
  });

  it('forgets failures outside the window', async () => {
    const cb = await breaker({ failureWindowMs: 100 });
    const id = anyInstanceId();
    await cb.recordFailure(id);
    await sleep(150);
    await cb.recordFailure(id);
    expect((await cb.acquire(id)).allowed).toBe(true);
  });
});
