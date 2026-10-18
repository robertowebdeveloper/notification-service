import type { Channel } from '../../contracts/channels.js';
import type { ErrorCode } from '../../contracts/http-schemas.js';

/**
 * Application-facing metrics port. Every label is a closed enumeration or a provider type
 * (bounded by the provider registry): never recipients, notification/delivery ids, tenant ids or
 * free-text error messages. Implementations must never throw from these methods.
 */

/** Public API operations that can be accepted or rejected. */
export const API_OPERATIONS = ['create_notification', 'retry_notification'] as const;
export type ApiOperation = (typeof API_OPERATIONS)[number];

/** Why a webhook request was refused (after the provider type was recognised). */
export const WEBHOOK_INVALID_REASONS = [
  'invalid_signature',
  'stale_timestamp',
  'malformed',
  'unknown_instance',
  'unavailable',
] as const;
export type WebhookInvalidReason = (typeof WEBHOOK_INVALID_REASONS)[number];

/** Outcome of one provider call, as classified by the adapter (after replay downgrades). */
export const PROVIDER_CALL_OUTCOMES = ['accepted', 'rejected', 'unknown'] as const;
export type ProviderCallOutcome = (typeof PROVIDER_CALL_OUTCOMES)[number];

/** How a delivery reached `unknown`. */
export const UNKNOWN_SOURCES = ['ambiguous_result', 'stale_lease', 'replay_abandoned'] as const;
export type UnknownSource = (typeof UNKNOWN_SOURCES)[number];

/** Terminal delivery states. */
export const FINAL_OUTCOMES = ['accepted', 'failed', 'expired', 'suppressed'] as const;
export type FinalOutcome = (typeof FINAL_OUTCOMES)[number];

/** Mirrors `QueuePublishError['code']`. */
export const PUBLISH_FAILURE_REASONS = [
  'queue_unavailable',
  'publish_timeout',
  'publish_failed',
  'no_queue',
] as const;
export type PublishFailureReason = (typeof PUBLISH_FAILURE_REASONS)[number];

/** One counter per field of the reconciliation reports, plus failed steps. */
export const RECONCILIATION_RESULTS = [
  'rearmed',
  'stale_to_unknown',
  'unknown_checked',
  'unknown_accepted',
  'replay_scheduled',
  'events_processed',
  'events_orphaned',
  'step_failed',
] as const;
export type ReconciliationResult = (typeof RECONCILIATION_RESULTS)[number];

export interface Metrics {
  /** A request was accepted (including idempotent replays). */
  apiRequestAccepted(operation: ApiOperation): void;
  /** A request was refused; `reason` is the uniform error code of the response. */
  apiRequestRejected(operation: ApiOperation, reason: ErrorCode): void;

  /** An authenticated webhook request was stored (`providerType` must be a registered type). */
  webhookReceived(providerType: string): void;
  /** A webhook request was refused (`providerType` must be a registered type). */
  webhookInvalid(providerType: string, reason: WebhookInvalidReason): void;

  /** Time from notification creation to the start of the first provider attempt. */
  observeTimeToFirstAttempt(channel: Channel, seconds: number): void;
  /** Wall time of one provider `send` call. */
  observeProviderCall(providerType: string, outcome: ProviderCallOutcome, seconds: number): void;
  /** A retry on the same route was scheduled after a provider rejection. */
  retryScheduled(channel: Channel, providerType: string): void;
  /** A fallback to the next provider of the routing snapshot was scheduled. */
  fallbackTaken(channel: Channel, fromProviderType: string): void;
  /**
   * Deliveries moved to `unknown` (`count` defaults to 1). No channel label: the reconciler's
   * bulk stale-lease update only reports a count.
   */
  unknownTransition(source: UnknownSource, count?: number): void;
  /** A delivery reached a terminal state. */
  finalOutcome(channel: Channel, outcome: FinalOutcome): void;

  /** Outbox events confirmed by the queue. */
  outboxPublished(count: number): void;
  /** Outbox events left re-publishable because the publication failed. */
  outboxPublishFailed(reason: PublishFailureReason, count: number): void;
  /** Reconciliation counters (call once per field per cycle; zero counts are ignored). */
  reconciliation(result: ReconciliationResult, count: number): void;
}

/** Disabled metrics: for tests and for processes that do not expose `/metrics`. */
export class NoopMetrics implements Metrics {
  apiRequestAccepted(): void {
    /* noop */
  }
  apiRequestRejected(): void {
    /* noop */
  }
  webhookReceived(): void {
    /* noop */
  }
  webhookInvalid(): void {
    /* noop */
  }
  observeTimeToFirstAttempt(): void {
    /* noop */
  }
  observeProviderCall(): void {
    /* noop */
  }
  retryScheduled(): void {
    /* noop */
  }
  fallbackTaken(): void {
    /* noop */
  }
  unknownTransition(): void {
    /* noop */
  }
  finalOutcome(): void {
    /* noop */
  }
  outboxPublished(): void {
    /* noop */
  }
  outboxPublishFailed(): void {
    /* noop */
  }
  reconciliation(): void {
    /* noop */
  }
}

export const noopMetrics: Metrics = new NoopMetrics();
