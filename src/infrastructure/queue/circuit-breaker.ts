import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { BreakerPermit, ProviderCircuitBreaker } from '../../application/delivery/ports.js';
import type { CircuitBreakerSettings } from '../../application/ports/lookup-repositories.js';
import { withTimeout } from './with-timeout.js';

export interface CircuitBreakerOptions {
  prefix?: string;
  /** Defaults (`CIRCUIT_BREAKER_*`) for instances without their own override. */
  failureThreshold?: number;
  failureWindowMs?: number;
  /** Open time before a single recovery probe is allowed. */
  openMs?: number;
  /** Probe lease: while it lasts no other call goes through a half-open breaker. */
  probeTtlMs?: number;
  commandTimeoutMs?: number;
}

/** Valkey server time in milliseconds (shared by every script). */
const NOW = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
`;

// Returns {allowed, probe, waitMs}. ARGV[2] identifies the probe holder.
const ACQUIRE_SCRIPT = `${NOW}
local probe_ttl = tonumber(ARGV[1])
local s = redis.call('HMGET', KEYS[1], 'state', 'open_until', 'probe_until')
local state = s[1] or 'closed'
if state == 'closed' then return { 1, 0, 0 } end
if state == 'open' then
  local open_until = tonumber(s[2]) or 0
  if now < open_until then return { 0, 0, open_until - now } end
else
  local probe_until = tonumber(s[3]) or 0
  if now < probe_until then return { 0, 0, probe_until - now } end
end
redis.call('HSET', KEYS[1], 'state', 'half_open', 'probe_until', tostring(now + probe_ttl),
  'probe_token', ARGV[2])
redis.call('PEXPIRE', KEYS[1], probe_ttl + 3600000)
return { 1, 1, 0 }
`;

// ARGV[1]: probe token of the caller ('' when it holds none). In half-open state only the probe
// holder closes the breaker: a late success of a call started before the breaker opened does not.
const SUCCESS_SCRIPT = `
local s = redis.call('HMGET', KEYS[1], 'state', 'probe_token')
local state = s[1]
if state == 'open' then return 0 end
if state == 'half_open' and (ARGV[1] == '' or ARGV[1] ~= s[2]) then return 0 end
redis.call('DEL', KEYS[1])
return 1
`;

// Gives back an unused half-open probe (only its holder can): the next caller may probe at once.
const RELEASE_PROBE_SCRIPT = `
local s = redis.call('HMGET', KEYS[1], 'state', 'probe_token')
if s[1] == 'half_open' and ARGV[1] ~= '' and s[2] == ARGV[1] then
  redis.call('HSET', KEYS[1], 'probe_until', '0')
  redis.call('HDEL', KEYS[1], 'probe_token')
  return 1
end
return 0
`;

const FAILURE_SCRIPT = `${NOW}
local threshold = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local open_ms = tonumber(ARGV[3])
local s = redis.call('HMGET', KEYS[1], 'state', 'failures', 'window_start')
local state = s[1] or 'closed'
if state == 'open' then return 0 end
local failures = tonumber(s[2]) or 0
local window_start = tonumber(s[3])
if state == 'closed' then
  if window_start == nil or now - window_start > window then
    failures = 0
    window_start = now
  end
  failures = failures + 1
end
if state == 'half_open' or failures >= threshold then
  redis.call('HSET', KEYS[1], 'state', 'open', 'open_until', tostring(now + open_ms),
    'failures', '0', 'window_start', tostring(now))
  redis.call('PEXPIRE', KEYS[1], open_ms + window + 3600000)
  return 1
end
redis.call('HSET', KEYS[1], 'state', 'closed', 'failures', tostring(failures),
  'window_start', tostring(window_start))
redis.call('PEXPIRE', KEYS[1], window + 60000)
return 0
`;

const FORCE_OPEN_SCRIPT = `${NOW}
local duration = tonumber(ARGV[1])
local s = redis.call('HMGET', KEYS[1], 'state', 'open_until')
local open_until = now + duration
if s[1] == 'open' then
  local current = tonumber(s[2]) or 0
  if current > open_until then open_until = current end
end
redis.call('HSET', KEYS[1], 'state', 'open', 'open_until', tostring(open_until), 'failures', '0')
redis.call('PEXPIRE', KEYS[1], open_until - now + 3600000)
return 1
`;

type BreakerRedis = Redis & {
  nsBreakerAcquire(
    key: string,
    probeTtlMs: number,
    probeToken: string,
  ): Promise<[number, number, number]>;
  nsBreakerSuccess(key: string, probeToken: string): Promise<number>;
  nsBreakerReleaseProbe(key: string, probeToken: string): Promise<number>;
  nsBreakerFailure(
    key: string,
    threshold: number,
    windowMs: number,
    openMs: number,
  ): Promise<number>;
  nsBreakerForceOpen(key: string, durationMs: number): Promise<number>;
};

/**
 * Circuit breaker per provider instance shared through Valkey: closed -> open after
 * `failureThreshold` failures in the window; after `openMs` exactly one caller obtains the
 * half-open probe (atomic in Lua, identified by a random token); only the holder's success
 * closes the breaker, any failure re-opens it, and an unused probe can be given back.
 * Uses a fail-fast connection: when Valkey is down the caller must suspend sending.
 */
export class ValkeyCircuitBreaker implements ProviderCircuitBreaker {
  private readonly redis: BreakerRedis;
  private readonly prefix: string;
  private readonly failureThreshold: number;
  private readonly failureWindowMs: number;
  private readonly openMs: number;
  private readonly probeTtlMs: number;
  private readonly timeoutMs: number;

  constructor(redis: Redis, options: CircuitBreakerOptions = {}) {
    if (typeof (redis as unknown as Partial<BreakerRedis>).nsBreakerAcquire !== 'function') {
      redis.defineCommand('nsBreakerAcquire', { numberOfKeys: 1, lua: ACQUIRE_SCRIPT });
      redis.defineCommand('nsBreakerSuccess', { numberOfKeys: 1, lua: SUCCESS_SCRIPT });
      redis.defineCommand('nsBreakerFailure', { numberOfKeys: 1, lua: FAILURE_SCRIPT });
      redis.defineCommand('nsBreakerForceOpen', { numberOfKeys: 1, lua: FORCE_OPEN_SCRIPT });
      redis.defineCommand('nsBreakerReleaseProbe', { numberOfKeys: 1, lua: RELEASE_PROBE_SCRIPT });
    }
    this.redis = redis as unknown as BreakerRedis;
    this.prefix = options.prefix ?? 'ns:breaker';
    this.failureThreshold = options.failureThreshold ?? 5;
    this.failureWindowMs = options.failureWindowMs ?? 30_000;
    this.openMs = options.openMs ?? 30_000;
    this.probeTtlMs = options.probeTtlMs ?? 60_000;
    this.timeoutMs = options.commandTimeoutMs ?? 2_000;
  }

  private key(id: number): string {
    return `${this.prefix}:{${id}}`;
  }

  async acquire(providerInstanceId: number): Promise<BreakerPermit> {
    const token = randomUUID();
    const [allowed, probe, wait] = await withTimeout(
      this.redis.nsBreakerAcquire(this.key(providerInstanceId), this.probeTtlMs, token),
      this.timeoutMs,
      'circuit breaker',
    );
    if (allowed !== 1) return { allowed: false, retryAfterMs: Math.max(1, wait) };
    return probe === 1
      ? { allowed: true, probe: true, probeToken: token }
      : { allowed: true, probe: false };
  }

  async recordSuccess(providerInstanceId: number, probeToken?: string): Promise<void> {
    await withTimeout(
      this.redis.nsBreakerSuccess(this.key(providerInstanceId), probeToken ?? ''),
      this.timeoutMs,
      'circuit breaker',
    );
  }

  async releaseProbe(providerInstanceId: number, probeToken: string): Promise<void> {
    await withTimeout(
      this.redis.nsBreakerReleaseProbe(this.key(providerInstanceId), probeToken),
      this.timeoutMs,
      'circuit breaker',
    );
  }

  async recordFailure(
    providerInstanceId: number,
    settings?: CircuitBreakerSettings,
  ): Promise<void> {
    await withTimeout(
      this.redis.nsBreakerFailure(
        this.key(providerInstanceId),
        settings?.failureThreshold ?? this.failureThreshold,
        settings?.failureWindowMs ?? this.failureWindowMs,
        settings?.openMs ?? this.openMs,
      ),
      this.timeoutMs,
      'circuit breaker',
    );
  }

  async forceOpen(providerInstanceId: number, durationMs: number): Promise<void> {
    await withTimeout(
      this.redis.nsBreakerForceOpen(this.key(providerInstanceId), durationMs),
      this.timeoutMs,
      'circuit breaker',
    );
  }
}
