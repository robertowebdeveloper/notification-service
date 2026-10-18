import type { ProviderError, SendResult } from '../contracts/provider-port.js';
import type { ReceiptStatus } from '../contracts/statuses.js';
import { planRetry, type RandomSource, type RetryPolicy } from './retry-policy.js';

/**
 * Mapping from a normalized provider result to the delivery transition.
 *
 * - accepted -> `accepted`; receipt `pending` when the adapter reports receipts, otherwise
 *   `unavailable` (a positive SMTP answer is never reported as delivered).
 * - unknown (or a rejection that is not certainly a non-acceptance) -> `unknown`: never
 *   fallback, never re-send from here.
 * - permanent -> `failed`.
 * - retryable -> `retry_wait` with exponential backoff + jitter honouring Retry-After, within
 *   the attempt budget and the delivery expiry, otherwise `failed`.
 * - configuration -> immediate fallback (`retry_wait` due now) when another provider is
 *   eligible, otherwise `failed`. The caller raises the alarm and quarantines the instance.
 */
export type SendDecision =
  | { kind: 'accepted'; receiptStatus: ReceiptStatus; externalReference: string | null }
  | { kind: 'unknown'; reason: string; externalReference: string | null }
  | { kind: 'retry'; at: Date; error: ProviderError; fallback: boolean }
  | { kind: 'fail'; error: ProviderError; reason: string };

export interface SendDecisionInput {
  result: SendResult;
  /** Attempts consumed including this one. */
  attemptsUsed: number;
  maxAttempts: number;
  now: Date;
  expiresAt: Date;
  receiptsSupported: boolean;
  /** Result of `isFallbackEligible` for this attempt (only consulted for configuration errors). */
  fallbackEligible: boolean;
  policy?: RetryPolicy;
  random?: RandomSource;
}

export function decideAfterSend(input: SendDecisionInput): SendDecision {
  const { result } = input;
  if (result.outcome === 'accepted') {
    return {
      kind: 'accepted',
      receiptStatus: input.receiptsSupported ? 'pending' : 'unavailable',
      externalReference: result.externalReference ?? null,
    };
  }
  if (result.outcome === 'unknown') {
    return {
      kind: 'unknown',
      reason: result.reason,
      externalReference: result.externalReference ?? null,
    };
  }

  const { error } = result;
  // Defensive: the contract requires certainty for every rejection; anything else is ambiguous.
  if (!error.definitelyNotAccepted) {
    return {
      kind: 'unknown',
      reason: `uncertain_rejection:${error.code}`,
      externalReference: null,
    };
  }

  switch (error.kind) {
    case 'permanent':
      return { kind: 'fail', error, reason: error.code };
    case 'configuration':
      return input.fallbackEligible && input.now.getTime() < input.expiresAt.getTime()
        ? { kind: 'retry', at: input.now, error, fallback: true }
        : { kind: 'fail', error, reason: error.code };
    case 'retryable': {
      const plan = planRetry({
        attemptsUsed: input.attemptsUsed,
        maxAttempts: input.maxAttempts,
        now: input.now,
        expiresAt: input.expiresAt,
        retryAfterMs: error.retryAfterMs,
        ...(input.policy !== undefined ? { policy: input.policy } : {}),
        ...(input.random !== undefined ? { random: input.random } : {}),
      });
      return plan.kind === 'retry'
        ? { kind: 'retry', at: plan.at, error, fallback: false }
        : { kind: 'fail', error, reason: plan.reason };
    }
  }
}

/**
 * Circuit-breaker signal for an attempt result (provider health, not message validity). A
 * definite permanent rejection proves the provider is reachable and answering: success.
 */
export type BreakerSignal = 'success' | 'failure' | 'quarantine';

export function breakerSignal(result: SendResult): BreakerSignal {
  if (result.outcome === 'accepted') return 'success';
  if (result.outcome === 'unknown') return 'failure';
  switch (result.error.kind) {
    case 'retryable':
      return 'failure';
    case 'configuration':
      return 'quarantine';
    case 'permanent':
      return 'success';
  }
}
