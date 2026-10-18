import type { Channel, ChannelPayload } from '../../contracts/channels.js';
import type { ProviderError } from '../../contracts/provider-port.js';
import type { ReceiptStatus, SubmissionStatus } from '../../contracts/statuses.js';

/**
 * Repository contracts shared by API, dispatcher and worker.
 * Every method takes tenantId explicitly where data is tenant-scoped.
 * Implementations live in infrastructure/database and must use short transactions
 * with a forked EntityManager per call.
 */

export interface RoutingSnapshot {
  policyId: number;
  policyVersion: number;
  /** Channel platform (push/messaging); null for email and sms. */
  platform: string | null;
  /** Ordered provider instance ids considered for this delivery. */
  providerInstanceIds: number[];
  maxAttempts: number;
  /** Policy flag: when false only the first instance may be used (no fallback). */
  fallbackEnabled: boolean;
}

export interface CreateNotificationInput {
  tenantId: number;
  idempotencyKey: string;
  requestHash: string;
  routingKey: string;
  payload: ChannelPayload;
  metadata: Record<string, string | number | boolean>;
  routing: RoutingSnapshot;
  expiresAt: Date;
}

export type CreateNotificationResult =
  | { kind: 'created'; notificationId: number }
  | { kind: 'replayed'; notificationId: number }
  | { kind: 'conflict' };

export interface NotificationSummary {
  id: number;
  channel: Channel;
  /** Channel platform from the routing snapshot (push/messaging); null for email and sms. */
  platform: string | null;
  routingKey: string;
  submissionStatus: SubmissionStatus;
  receiptStatus: ReceiptStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface AttemptSummary {
  number: number;
  outcome: 'started' | 'accepted' | 'rejected' | 'unknown';
  startedAt: Date;
  finishedAt: Date | null;
  errorCode: string | null;
}

export interface NotificationDetail extends NotificationSummary {
  attempts: AttemptSummary[];
  lastError: { code: string; message: string } | null;
}

export interface ListNotificationsFilter {
  status?: SubmissionStatus;
  channel?: Channel;
  createdFrom?: Date;
  createdTo?: Date;
  cursor?: string;
  limit: number;
}

/** Stored idempotency record of a notification (tenant-scoped key). */
export interface IdempotencyRecord {
  notificationId: number;
  requestHash: string;
}

export interface NotificationRepository {
  /** Inserts notification, delivery (pending) and outbox event in one transaction; idempotent via SQL unique constraint. */
  create(input: CreateNotificationInput): Promise<CreateNotificationResult>;
  /**
   * Read-only lookup used to answer replays before routing. `create` stays the source of truth
   * for concurrent identical requests (insert-level idempotency).
   */
  findByIdempotencyKey(tenantId: number, idempotencyKey: string): Promise<IdempotencyRecord | null>;
  findById(tenantId: number, id: number): Promise<NotificationDetail | null>;
  list(
    tenantId: number,
    filter: ListNotificationsFilter,
  ): Promise<{ items: NotificationSummary[]; nextCursor: string | null }>;
  /** Outbox events due for publication and not yet published (future events excluded). */
  countPendingOutbox(): Promise<number>;
}

export interface ClaimedOutboxEvent {
  id: number;
  deliveryId: number;
  generation: number;
  channel: Channel;
  dispatchCount: number;
  leaseToken: string;
}

/** A published event whose job may have been lost (see `findLostPublications`). */
export interface LostPublicationCandidate {
  id: number;
  deliveryId: number;
  channel: Channel;
  /** Dispatch count of the last publication: its job id is `dispatch-<id>-<dispatchCount>`. */
  dispatchCount: number;
}

/**
 * Lease, availability and staleness comparisons use the database clock (`now()`), never the
 * clock of the calling process: dispatchers and workers with skewed clocks share one view.
 */
export interface OutboxRepository {
  /** SELECT ... FOR UPDATE SKIP LOCKED, sets lease and increments dispatch_count. */
  claimAvailable(limit: number, leaseMs: number): Promise<ClaimedOutboxEvent[]>;
  markPublished(id: number, leaseToken: string): Promise<boolean>;
  /** Back to 'pending', publishable again `retryAfterMs` from now (0: immediately). */
  releaseAfterError(
    id: number,
    leaseToken: string,
    technicalError: string,
    retryAfterMs: number,
  ): Promise<boolean>;
  /**
   * Published events older than `olderThanMs` whose delivery is still runnable for the same
   * generation, is due and has no active lease (read only).
   */
  findLostPublications(olderThanMs: number, limit: number): Promise<LostPublicationCandidate[]>;
  /**
   * Re-arms the given candidates (back to 'pending', due now) if they are still lost with the
   * same dispatch count; the next claim yields a new job id. Returns the number re-armed.
   */
  rearmPublications(candidates: readonly LostPublicationCandidate[]): Promise<number>;
}

export interface ClaimedDelivery {
  deliveryId: number;
  tenantId: number;
  notificationId: number;
  generation: number;
  /** Fencing token: incremented on every claim. */
  version: number;
  leaseToken: string;
  payload: ChannelPayload;
  routing: RoutingSnapshot;
  attemptsUsed: number;
  expiresAt: Date;
  /** Creation time of the notification (time-to-first-attempt metric). */
  createdAt: Date;
}

export interface AttemptStart {
  attemptNumber: number;
  providerInstanceId: number;
  providerInstanceRevision: number;
  providerIdempotencyKey: string;
}

export type AttemptResolution =
  | { outcome: 'accepted'; externalReference: string | null; receiptStatus: ReceiptStatus }
  | {
      outcome: 'rejected';
      error: ProviderError;
      next: { kind: 'retry'; at: Date } | { kind: 'fail' };
    }
  | { outcome: 'unknown'; reason: string; externalReference: string | null };

export interface DeliveryRepository {
  /**
   * Atomic conditional update on status, generation, lease and `next_attempt_at` (a duplicate
   * job can never skip a deferral); returns null for stale or not yet due jobs.
   */
  claim(deliveryId: number, generation: number, leaseMs: number): Promise<ClaimedDelivery | null>;
  renewLease(
    deliveryId: number,
    leaseToken: string,
    version: number,
    leaseMs: number,
  ): Promise<boolean>;
  /**
   * Persists attempt 'started' and delivery 'sending' before the provider call; returns the new
   * attempt id, or null when fenced out.
   */
  startAttempt(claim: ClaimedDelivery, attempt: AttemptStart): Promise<number | null>;
  /**
   * Fenced by version/lease; retry creates next generation + outbox event in the same
   * transaction. Locks the delivery row before the attempt row (same order as every other
   * multi-table writer). Idempotent: a retry after a transient error is safe.
   */
  resolveAttempt(
    claim: ClaimedDelivery,
    attemptId: number,
    resolution: AttemptResolution,
  ): Promise<boolean>;
  markTerminal(
    claim: ClaimedDelivery,
    status: Extract<SubmissionStatus, 'failed' | 'suppressed' | 'expired'>,
    reasonCode: string,
  ): Promise<boolean>;
  /** Expired 'sending' leases (database clock) are moved to 'unknown', never re-sent directly. */
  markStaleSendingUnknown(limit: number): Promise<number>;
}

export interface ManualRetryInput {
  tenantId: number;
  notificationId: number;
  /** Idempotency-Key of the retry request, scoped to tenant + notification. */
  retryIdempotencyKey: string;
  /** API key id performing the operation (recorded in audit_events). */
  actorApiKeyId: number;
  /** New attempt budget granted by this retry. */
  maxAttempts: number;
  now: Date;
}

export type ManualRetryResult =
  | { kind: 'scheduled'; generation: number }
  | { kind: 'replayed'; generation: number }
  | { kind: 'not_found' }
  /** Delivery is not `failed` with a certain rejection (accepted, unknown, suppressed, in progress...). */
  | { kind: 'not_retryable'; submissionStatus: SubmissionStatus };

export interface ManualRetryRepository {
  /**
   * One transaction: lock the delivery, verify `failed` with every attempt definitely rejected,
   * reset the budget, bump generation, insert the outbox event and the audit event.
   * Concurrent requests with the same key yield one `scheduled` and `replayed` for the others.
   */
  retryFailed(input: ManualRetryInput): Promise<ManualRetryResult>;
}
