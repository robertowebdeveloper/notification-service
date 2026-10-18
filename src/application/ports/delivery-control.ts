import type { Channel, ChannelPayload } from '../../contracts/channels.js';
import type { ProviderErrorKind } from '../../contracts/provider-port.js';
import type { AttemptOutcome, ReceiptStatus, SubmissionStatus } from '../../contracts/statuses.js';
import type { ClaimedDelivery } from './repositories.js';

/**
 * Delivery-control operations used by the worker and the reconciler on top of the
 * `DeliveryRepository` contract (attempt history, deferrals, `unknown` resolution).
 * Implemented in infrastructure/database with fenced conditional updates.
 */

export interface AttemptRecord {
  attemptId: string;
  attemptNumber: number;
  generation: number;
  providerInstanceId: string;
  providerIdempotencyKey: string;
  outcome: AttemptOutcome;
  errorKind: ProviderErrorKind | null;
  errorCode: string | null;
  externalReference: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface UnknownDelivery {
  tenantId: string;
  deliveryId: string;
  generation: number;
  version: number;
  attemptsUsed: number;
  maxAttempts: number;
  expiresAt: Date;
  /** Latest attempt of the delivery (the ambiguous one). */
  lastAttempt: AttemptRecord;
  /** First use of the last attempt's idempotency key: start of the provider window. */
  keyFirstUsedAt: Date;
}

export interface DeliveryTarget {
  tenantId: string;
  deliveryId: string;
  channel: Channel;
  submissionStatus: SubmissionStatus;
  receiptStatus: ReceiptStatus;
  payload: ChannelPayload;
}

export interface DeliveryControlRepository {
  /** Attempts of a delivery, oldest first. */
  attemptHistory(tenantId: string, deliveryId: string): Promise<AttemptRecord[]>;
  /**
   * Reschedules a claimed, still runnable delivery without consuming an attempt (local quota,
   * limiter/breaker unavailable, no provider usable right now): releases the lease and makes the
   * outbox event of the same generation publishable again `delayMs` from now (database clock),
   * never later than the delivery expiry.
   */
  defer(claim: ClaimedDelivery, delayMs: number, reasonCode: string): Promise<boolean>;
  /**
   * A scheduled safe replay that can no longer run safely (window elapsed, expired, suppressed,
   * provider unusable) goes back to `unknown`: an ambiguous send never becomes terminal here.
   */
  returnToUnknown(claim: ClaimedDelivery, reasonCode: string): Promise<boolean>;
  /** `unknown` deliveries not checked for `minIntervalMs` (database clock), oldest check first. */
  findUnknown(minIntervalMs: number, limit: number): Promise<UnknownDelivery[]>;
  /** Records that reconciliation looked at the delivery (throttles the next check). */
  touchUnknown(tenantId: string, deliveryId: string, version: number): Promise<boolean>;
  /**
   * `unknown` -> `accepted` on provider evidence (status query or webhook); the latest ambiguous
   * attempt (any generation) becomes `accepted`. Also applies to a delivery waiting in
   * `retry_wait` for a safe replay (latest attempt `unknown`, no attempt in flight): the replay
   * is cancelled (a worker holding the claim is fenced by the version bump). `version` fences
   * status-query results on `unknown` deliveries; webhooks pass null.
   */
  resolveUnknownAccepted(
    tenantId: string,
    deliveryId: string,
    version: number | null,
    receiptStatus: ReceiptStatus,
    externalReference: string | null,
  ): Promise<boolean>;
  /**
   * `unknown` -> `retry_wait` with a new generation and outbox event due at `at`, so the next
   * attempt replays the ambiguous operation through the same provider with the same key.
   */
  scheduleSafeReplay(
    tenantId: string,
    deliveryId: string,
    version: number,
    at: Date,
  ): Promise<boolean>;
  findTarget(tenantId: string, deliveryId: string): Promise<DeliveryTarget | null>;
}
