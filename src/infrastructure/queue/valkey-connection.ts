import { Redis, type RedisOptions } from 'ioredis';

/** Workers: retry forever, as required by BullMQ for blocking connections. */
export function createWorkerConnection(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    retryStrategy: (times) => Math.min(times * 500, 10_000),
  });
}

/** Producers (dispatcher, API checks): fail fast so outbox events stay re-publishable. */
export function createProducerConnection(url: string, overrides: RedisOptions = {}): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 5_000,
    commandTimeout: 5_000,
    retryStrategy: (times) => Math.min(times * 500, 5_000),
    ...overrides,
  });
}
