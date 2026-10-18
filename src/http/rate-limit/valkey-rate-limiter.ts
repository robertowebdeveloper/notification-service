import type { Redis } from 'ioredis';
import type { RateLimitDecision, RateLimiter } from '../../application/notifications/ports.js';

/** Fixed-window counter: INCR + PEXPIRE executed atomically in one script. */
const SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}`;

/** Current count and remaining window, without incrementing. */
const PEEK_SCRIPT = `
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
local ttl = redis.call('PTTL', KEYS[1])
return {count, ttl}`;

export class ValkeyRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly keyPrefix = 'ns:ratelimit:',
  ) {}

  async consume(key: string, limit: number, windowMs: number): Promise<RateLimitDecision> {
    if (this.redis.status !== 'ready') throw new Error(`valkey not ready (${this.redis.status})`);
    const result = (await this.redis.eval(SCRIPT, 1, this.keyPrefix + key, windowMs)) as [
      number,
      number,
    ];
    const [count, ttl] = result;
    return { allowed: count <= limit, retryAfterMs: Math.max(0, ttl) };
  }

  async peek(key: string, limit: number): Promise<RateLimitDecision> {
    if (this.redis.status !== 'ready') throw new Error(`valkey not ready (${this.redis.status})`);
    const result = (await this.redis.eval(PEEK_SCRIPT, 1, this.keyPrefix + key)) as [
      number,
      number,
    ];
    const [count, ttl] = result;
    return { allowed: count < limit, retryAfterMs: Math.max(0, ttl) };
  }
}
