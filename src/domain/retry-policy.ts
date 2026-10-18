/**
 * Application-level retry rules. PostgreSQL owns the attempt budget and the schedule; BullMQ
 * jobs run with `attempts: 1` and never retry on their own.
 */
export interface RetryPolicy {
  /** Delay before the second attempt. */
  baseDelayMs: number;
  /** Upper bound of the exponential delay (before Retry-After). */
  maxDelayMs: number;
  /**
   * Fraction of the exponential delay that is randomized (0 = none, 1 = full jitter).
   * 0.5 ("equal jitter") keeps at least half of the delay while spreading retries.
   */
  jitterRatio: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  baseDelayMs: 5_000,
  maxDelayMs: 5 * 60_000,
  jitterRatio: 0.5,
});

/** Proposed defaults: five provider calls per delivery, useful for 24 hours. */
export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_DELIVERY_TTL_MS = 24 * 3600_000;

export type RandomSource = () => number;

function clampUnit(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value >= 1 ? 0.999_999 : value;
}

/**
 * Exponential delay after `failedAttempts` attempts (1 -> base, 2 -> 2*base, ...), capped at
 * `maxDelayMs`, with the configured jitter subtracted from the capped value.
 */
export function computeBackoffMs(
  failedAttempts: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: RandomSource = Math.random,
): number {
  const exponent = Math.max(0, Math.min(failedAttempts - 1, 30));
  const capped = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
  const ratio = Math.min(1, Math.max(0, policy.jitterRatio));
  const jitter = capped * ratio * clampUnit(random());
  return Math.max(0, Math.round(capped - jitter));
}

/** Delay honouring a provider Retry-After: never earlier than the provider asked. */
export function retryDelayMs(
  failedAttempts: number,
  retryAfterMs: number | undefined,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: RandomSource = Math.random,
): number {
  const backoff = computeBackoffMs(failedAttempts, policy, random);
  if (retryAfterMs === undefined || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) {
    return backoff;
  }
  return Math.max(backoff, Math.ceil(retryAfterMs));
}

/** True when another provider call fits in the budget after `attemptsUsed` calls. */
export function hasAttemptBudget(attemptsUsed: number, maxAttempts: number): boolean {
  return attemptsUsed < maxAttempts;
}

export type RetryPlan =
  | { kind: 'retry'; at: Date; delayMs: number }
  | { kind: 'fail'; reason: 'attempts_exhausted' | 'expires_before_retry' };

export interface RetryPlanInput {
  /** Calls already consumed, including the one that just failed. */
  attemptsUsed: number;
  maxAttempts: number;
  now: Date;
  expiresAt: Date;
  retryAfterMs?: number | undefined;
  policy?: RetryPolicy;
  random?: RandomSource;
}

/** Next step after a definitely-not-accepted, retryable rejection. */
export function planRetry(input: RetryPlanInput): RetryPlan {
  if (!hasAttemptBudget(input.attemptsUsed, input.maxAttempts)) {
    return { kind: 'fail', reason: 'attempts_exhausted' };
  }
  const delayMs = retryDelayMs(
    input.attemptsUsed,
    input.retryAfterMs,
    input.policy ?? DEFAULT_RETRY_POLICY,
    input.random ?? Math.random,
  );
  const at = new Date(input.now.getTime() + delayMs);
  if (at.getTime() >= input.expiresAt.getTime()) {
    return { kind: 'fail', reason: 'expires_before_retry' };
  }
  return { kind: 'retry', at, delayMs };
}

export function isExpired(expiresAt: Date, now: Date): boolean {
  return now.getTime() >= expiresAt.getTime();
}
