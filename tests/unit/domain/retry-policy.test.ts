import { describe, expect, it } from 'vitest';
import {
  computeBackoffMs,
  DEFAULT_RETRY_POLICY,
  hasAttemptBudget,
  isExpired,
  planRetry,
  retryDelayMs,
} from '../../../src/domain/retry-policy.js';

const noJitter = () => 0;
const maxJitter = () => 0.999_999;
const now = new Date('2026-10-18T10:00:00.000Z');
const in24h = new Date(now.getTime() + 24 * 3600_000);

describe('computeBackoffMs', () => {
  it('grows exponentially from 5 seconds and caps at 5 minutes without jitter', () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) =>
      computeBackoffMs(n, DEFAULT_RETRY_POLICY, noJitter),
    );
    expect(delays).toEqual([
      5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000,
    ]);
  });

  it('applies equal jitter: never below half of the exponential delay', () => {
    expect(computeBackoffMs(1, DEFAULT_RETRY_POLICY, maxJitter)).toBe(2_500);
    expect(computeBackoffMs(10, DEFAULT_RETRY_POLICY, maxJitter)).toBe(150_000);
    for (let i = 0; i < 200; i += 1) {
      const delay = computeBackoffMs(3, DEFAULT_RETRY_POLICY);
      expect(delay).toBeGreaterThanOrEqual(10_000);
      expect(delay).toBeLessThanOrEqual(20_000);
    }
  });

  it('spreads concurrent retries (jitter is not constant)', () => {
    const delays = new Set(
      Array.from({ length: 50 }, () => computeBackoffMs(4, DEFAULT_RETRY_POLICY)),
    );
    expect(delays.size).toBeGreaterThan(10);
  });

  it('tolerates out-of-range random sources and huge attempt numbers', () => {
    expect(computeBackoffMs(1_000, DEFAULT_RETRY_POLICY, () => Number.NaN)).toBe(300_000);
    expect(computeBackoffMs(0, DEFAULT_RETRY_POLICY, () => -1)).toBe(5_000);
  });
});

describe('retryDelayMs', () => {
  it('honours Retry-After when longer than the backoff', () => {
    expect(retryDelayMs(1, 60_000, DEFAULT_RETRY_POLICY, noJitter)).toBe(60_000);
  });

  it('keeps the backoff when Retry-After is shorter or invalid', () => {
    expect(retryDelayMs(3, 1_000, DEFAULT_RETRY_POLICY, noJitter)).toBe(20_000);
    expect(retryDelayMs(1, -5, DEFAULT_RETRY_POLICY, noJitter)).toBe(5_000);
    expect(retryDelayMs(1, Number.NaN, DEFAULT_RETRY_POLICY, noJitter)).toBe(5_000);
  });

  it('may exceed the 5 minute cap when the provider asks for it', () => {
    expect(retryDelayMs(1, 900_000, DEFAULT_RETRY_POLICY, noJitter)).toBe(900_000);
  });
});

describe('attempt budget', () => {
  it('allows calls while attempts used are below the maximum', () => {
    expect(hasAttemptBudget(0, 5)).toBe(true);
    expect(hasAttemptBudget(4, 5)).toBe(true);
    expect(hasAttemptBudget(5, 5)).toBe(false);
  });
});

describe('planRetry', () => {
  it('schedules the next attempt with backoff', () => {
    const plan = planRetry({
      attemptsUsed: 2,
      maxAttempts: 5,
      now,
      expiresAt: in24h,
      random: noJitter,
    });
    expect(plan).toEqual({ kind: 'retry', at: new Date(now.getTime() + 10_000), delayMs: 10_000 });
  });

  it('fails when the budget of five calls is used', () => {
    expect(planRetry({ attemptsUsed: 5, maxAttempts: 5, now, expiresAt: in24h })).toEqual({
      kind: 'fail',
      reason: 'attempts_exhausted',
    });
  });

  it('fails when the retry would happen after the delivery expiry', () => {
    const plan = planRetry({
      attemptsUsed: 1,
      maxAttempts: 5,
      now,
      expiresAt: new Date(now.getTime() + 30_000),
      retryAfterMs: 60_000,
    });
    expect(plan).toEqual({ kind: 'fail', reason: 'expires_before_retry' });
  });

  it('detects expiry at the exact deadline', () => {
    expect(isExpired(now, now)).toBe(true);
    expect(isExpired(in24h, now)).toBe(false);
  });
});
