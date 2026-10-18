import { createHash } from 'node:crypto';
import type { ProviderCapabilities } from '../contracts/provider-port.js';

const KEY_PREFIX = 'nsd1';

export interface ProviderOperation {
  tenantId: number;
  deliveryId: number;
  /**
   * Sequential ids repeat after a database reset or in another environment sharing the provider
   * account: the creation time keeps keys of different deliveries apart.
   */
  deliveryCreatedAt: Date;
  providerInstanceId: number;
  /**
   * Attempt number that started the operation. A new operation (first attempt, retry after a
   * certain rejection, fallback) gets a new key; a safe replay of an ambiguous attempt reuses
   * the key persisted on that attempt instead of deriving a new one.
   */
  operationAttemptNumber: number;
}

/**
 * Deterministic provider idempotency key derived from the persisted operation. It contains no
 * PII (hash of identifiers only) and is printable ASCII, accepted by every adapter.
 */
export function deriveProviderIdempotencyKey(operation: ProviderOperation): string {
  const digest = createHash('sha256')
    .update(
      [
        operation.tenantId,
        operation.deliveryId,
        operation.deliveryCreatedAt.toISOString(),
        operation.providerInstanceId,
        String(operation.operationAttemptNumber),
      ].join(':'),
    )
    .digest('hex');
  return `${KEY_PREFIX}-${digest}`;
}

/** Default margin kept before the end of the provider's documented idempotency window. */
export const DEFAULT_REPLAY_SAFETY_MARGIN_MS = 3600_000;

/**
 * Last instant at which an ambiguous send may be replayed with the same key, or null when the
 * provider offers no idempotency (a replay would never be safe).
 */
export function safeReplayDeadline(
  capabilities: ProviderCapabilities,
  keyFirstUsedAt: Date,
  safetyMarginMs: number = DEFAULT_REPLAY_SAFETY_MARGIN_MS,
): Date | null {
  if (!capabilities.idempotency.supported) return null;
  const windowMs = capabilities.idempotency.windowSeconds * 1000;
  const usableMs = windowMs - Math.max(0, safetyMarginMs);
  if (usableMs <= 0) return null;
  return new Date(keyFirstUsedAt.getTime() + usableMs);
}

export function isWithinReplayWindow(
  capabilities: ProviderCapabilities,
  keyFirstUsedAt: Date,
  now: Date,
  safetyMarginMs: number = DEFAULT_REPLAY_SAFETY_MARGIN_MS,
): boolean {
  const deadline = safeReplayDeadline(capabilities, keyFirstUsedAt, safetyMarginMs);
  return deadline !== null && now.getTime() < deadline.getTime();
}
