import { once } from 'node:events';
import type { Redis } from 'ioredis';

/** Connection URLs for the local Compose infrastructure (overridable from the environment). */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://notifications:notifications@localhost:5432/notifications_test';

export const TEST_VALKEY_URL = process.env.TEST_VALKEY_URL ?? 'redis://localhost:6379/1';

/** Unique, recognisable suffix for resources created by a test run. */
export function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Producer connections disable the offline queue: wait for `ready` before issuing commands. */
export async function ready(redis: Redis): Promise<Redis> {
  if (redis.status !== 'ready') await once(redis, 'ready');
  return redis;
}
