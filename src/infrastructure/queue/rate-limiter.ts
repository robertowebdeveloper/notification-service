import type { Redis } from 'ioredis';
import type { ProviderRateLimiter, RateLimitDecision } from '../../application/delivery/ports.js';
import type { SendRateLimit } from '../../application/ports/lookup-repositories.js';
import { withTimeout } from './with-timeout.js';

export interface ValkeyRateLimiterOptions {
  /** Key namespace (tests use a unique one). */
  prefix?: string;
  /** Limit applied to instances without their own override (`PROVIDER_RATE_LIMIT_*`). */
  defaultLimit?: SendRateLimit;
  /** Deadline of one limiter call; past it the limiter counts as unavailable. */
  commandTimeoutMs?: number;
}

/**
 * Atomic token bucket. Time comes from the Valkey server (`TIME`) so workers with skewed clocks
 * share one consistent view. Returns {allowed, waitMs}.
 */
const TOKEN_BUCKET_SCRIPT = `
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2]) / 1000
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil or ts == nil then
  tokens = capacity
  ts = now
end
if now > ts then
  tokens = math.min(capacity, tokens + (now - ts) * rate)
  ts = now
end
local allowed = 0
local wait = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  wait = math.ceil((1 - tokens) / rate)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(ts))
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / rate) + 60000)
return { allowed, wait }
`;

export const DEFAULT_PROVIDER_LIMIT: SendRateLimit = Object.freeze({ burst: 20, perSecond: 10 });

type BucketRedis = Redis & {
  nsTokenBucket(key: string, capacity: number, refillPerSecond: number): Promise<[number, number]>;
};

/**
 * Per provider-instance quota shared by every worker. The connection must fail fast (producer
 * connection, no offline queue): when Valkey is unreachable `tryAcquire` throws and the worker
 * suspends sending instead of bypassing the quota.
 */
export class ValkeyTokenBucketRateLimiter implements ProviderRateLimiter {
  private readonly redis: BucketRedis;
  private readonly prefix: string;
  private readonly defaultLimit: SendRateLimit;
  private readonly timeoutMs: number;

  constructor(redis: Redis, options: ValkeyRateLimiterOptions = {}) {
    if (typeof (redis as unknown as Partial<BucketRedis>).nsTokenBucket !== 'function') {
      redis.defineCommand('nsTokenBucket', { numberOfKeys: 1, lua: TOKEN_BUCKET_SCRIPT });
    }
    this.redis = redis as unknown as BucketRedis;
    this.prefix = options.prefix ?? 'ns:ratelimit';
    this.defaultLimit = options.defaultLimit ?? DEFAULT_PROVIDER_LIMIT;
    this.timeoutMs = options.commandTimeoutMs ?? 2_000;
  }

  async tryAcquire(providerInstanceId: number, limit?: SendRateLimit): Promise<RateLimitDecision> {
    const effective = limit ?? this.defaultLimit;
    const [allowed, wait] = await withTimeout(
      this.redis.nsTokenBucket(
        `${this.prefix}:{${providerInstanceId}}`,
        effective.burst,
        effective.perSecond,
      ),
      this.timeoutMs,
      'rate limiter',
    );
    return allowed === 1 ? { allowed: true } : { allowed: false, retryAfterMs: Math.max(1, wait) };
  }
}
