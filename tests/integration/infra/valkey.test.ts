import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { createProducerConnection } from '../../../src/infrastructure/queue/valkey-connection.js';
import { TEST_VALKEY_URL, ready, uniqueSuffix } from './test-env.js';

async function configValue(redis: Redis, name: string): Promise<string | undefined> {
  const reply = (await redis.config('GET', name)) as string[];
  return reply[1];
}

describe('Valkey infrastructure', () => {
  let redis: Redis;

  beforeAll(async () => {
    redis = await ready(createProducerConnection(TEST_VALKEY_URL));
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('is reachable and stores keys', async () => {
    expect(await redis.ping()).toBe('PONG');
    const key = `infra-smoke:${uniqueSuffix()}`;
    try {
      await redis.set(key, 'ok', 'EX', 60);
      expect(await redis.get(key)).toBe('ok');
    } finally {
      await redis.del(key);
    }
  });

  it('is configured for queues: AOF enabled and no eviction', async () => {
    expect(await configValue(redis, 'appendonly')).toBe('yes');
    expect(await configValue(redis, 'maxmemory-policy')).toBe('noeviction');
  });
});
