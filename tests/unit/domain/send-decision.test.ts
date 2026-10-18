import { describe, expect, it } from 'vitest';
import type { ProviderError, SendResult } from '../../../src/contracts/provider-port.js';
import { breakerSignal, decideAfterSend } from '../../../src/domain/send-decision.js';

const now = new Date('2026-10-18T10:00:00.000Z');
const expiresAt = new Date(now.getTime() + 24 * 3600_000);

function rejection(kind: ProviderError['kind'], extra: Partial<ProviderError> = {}): SendResult {
  return {
    outcome: 'rejected',
    error: { kind, code: `${kind}_code`, message: 'msg', definitelyNotAccepted: true, ...extra },
  };
}

function decide(
  result: SendResult,
  overrides: Partial<Parameters<typeof decideAfterSend>[0]> = {},
) {
  return decideAfterSend({
    result,
    attemptsUsed: 1,
    maxAttempts: 5,
    now,
    expiresAt,
    receiptsSupported: false,
    fallbackEligible: false,
    random: () => 0,
    ...overrides,
  });
}

describe('decideAfterSend', () => {
  it('accepted without receipts -> accepted with receipt unavailable (SMTP)', () => {
    expect(decide({ outcome: 'accepted', externalReference: '<id@x>' })).toEqual({
      kind: 'accepted',
      receiptStatus: 'unavailable',
      externalReference: '<id@x>',
    });
  });

  it('accepted with receipts -> receipt pending', () => {
    expect(decide({ outcome: 'accepted' }, { receiptsSupported: true })).toEqual({
      kind: 'accepted',
      receiptStatus: 'pending',
      externalReference: null,
    });
  });

  it('unknown stays unknown and never falls back, even when fallback is eligible', () => {
    expect(
      decide(
        { outcome: 'unknown', reason: 'timeout_after_submission' },
        { fallbackEligible: true },
      ),
    ).toEqual({ kind: 'unknown', reason: 'timeout_after_submission', externalReference: null });
  });

  it('a rejection without certainty is treated as unknown', () => {
    const decision = decide(rejection('configuration', { definitelyNotAccepted: false }), {
      fallbackEligible: true,
    });
    expect(decision.kind).toBe('unknown');
  });

  it('permanent -> failed', () => {
    expect(decide(rejection('permanent'))).toMatchObject({
      kind: 'fail',
      reason: 'permanent_code',
    });
  });

  it('retryable -> retry with backoff', () => {
    expect(decide(rejection('retryable'), { attemptsUsed: 2 })).toMatchObject({
      kind: 'retry',
      at: new Date(now.getTime() + 10_000),
      fallback: false,
    });
  });

  it('retryable honours Retry-After', () => {
    expect(decide(rejection('retryable', { retryAfterMs: 120_000 }))).toMatchObject({
      kind: 'retry',
      at: new Date(now.getTime() + 120_000),
    });
  });

  it('retryable with the budget used -> fail attempts_exhausted', () => {
    expect(decide(rejection('retryable'), { attemptsUsed: 5 })).toMatchObject({
      kind: 'fail',
      reason: 'attempts_exhausted',
    });
  });

  it('configuration with an eligible fallback -> immediate retry flagged as fallback', () => {
    expect(decide(rejection('configuration'), { fallbackEligible: true })).toMatchObject({
      kind: 'retry',
      at: now,
      fallback: true,
    });
  });

  it('configuration without fallback -> failed', () => {
    expect(decide(rejection('configuration'))).toMatchObject({ kind: 'fail' });
  });
});

describe('breakerSignal', () => {
  it('maps provider health: a definite permanent rejection proves the provider answers', () => {
    expect(breakerSignal({ outcome: 'accepted' })).toBe('success');
    expect(breakerSignal({ outcome: 'unknown', reason: 'x' })).toBe('failure');
    expect(breakerSignal(rejection('retryable'))).toBe('failure');
    expect(breakerSignal(rejection('configuration'))).toBe('quarantine');
    expect(breakerSignal(rejection('permanent'))).toBe('success');
  });
});
