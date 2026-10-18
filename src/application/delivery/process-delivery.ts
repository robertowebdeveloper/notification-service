import type { Channel, PayloadByChannel } from '../../contracts/channels.js';
import type { DeliveryJobData } from '../../contracts/jobs.js';
import type { SendResult } from '../../contracts/provider-port.js';
import { deriveProviderIdempotencyKey, isWithinReplayWindow } from '../../domain/idempotency.js';
import {
  candidateOrder,
  excludedInstances,
  isFallbackEligible,
} from '../../domain/provider-eligibility.js';
import { recipientKey } from '../../domain/recipient.js';
import {
  DEFAULT_RETRY_POLICY,
  hasAttemptBudget,
  isExpired,
  type RandomSource,
  type RetryPolicy,
} from '../../domain/retry-policy.js';
import { breakerSignal, decideAfterSend, type SendDecision } from '../../domain/send-decision.js';
import { DEFAULT_REPLAY_SAFETY_MARGIN_MS } from '../../domain/idempotency.js';
import type {
  ProviderConfigRepository,
  SuppressionRepository,
} from '../ports/lookup-repositories.js';
import type {
  AttemptResolution,
  ClaimedDelivery,
  DeliveryRepository,
} from '../ports/repositories.js';
import type { AttemptRecord, DeliveryControlRepository } from '../ports/delivery-control.js';
import { noopMetrics, type Metrics } from '../ports/metrics.js';
import type {
  DeliveryLogger,
  ProviderCatalog,
  ProviderCircuitBreaker,
  ProviderRateLimiter,
  SecretSource,
} from './ports.js';
import { LeaseKeeper } from './lease-keeper.js';
import {
  BackendUnavailableError,
  fallbackEnabledOf,
  ProviderResolver,
  type SelectedProvider,
} from './provider-selection.js';

export interface ProcessDeliveryOptions {
  /** Worker lease on the delivery (renewed while the provider call is in flight). */
  leaseMs: number;
  /** Renewal period; 0 disables renewal (tests only). Defaults to leaseMs / 3. */
  leaseRenewIntervalMs?: number;
  /** Hard deadline of one provider call, enforced through the AbortSignal. */
  sendTimeoutMs: number;
  retryPolicy: RetryPolicy;
  /** Re-check delay when no provider is usable right now (kill switch, open breakers). */
  noProviderDeferMs: number;
  /** Re-check delay when the limiter or breaker backend is unavailable (sending suspended). */
  backendUnavailableDeferMs: number;
  /** Lower bound of the delay applied when the local quota has no capacity. */
  minRateLimitDeferMs: number;
  /** Breaker open time after a configuration error (operational quarantine). */
  configurationQuarantineMs: number;
  /** Margin kept before the end of the provider idempotency window for safe replays. */
  replaySafetyMarginMs: number;
  /**
   * First delay before retrying the recording of a provider outcome after a transient database
   * error (doubles up to `resolveRetryMaxDelayMs`). Retries stop when the lease could expire.
   */
  resolveRetryBaseDelayMs: number;
  resolveRetryMaxDelayMs: number;
}

export const DEFAULT_PROCESS_DELIVERY_OPTIONS: ProcessDeliveryOptions = Object.freeze({
  leaseMs: 60_000,
  sendTimeoutMs: 30_000,
  retryPolicy: DEFAULT_RETRY_POLICY,
  noProviderDeferMs: 30_000,
  backendUnavailableDeferMs: 5_000,
  minRateLimitDeferMs: 250,
  configurationQuarantineMs: 5 * 60_000,
  replaySafetyMarginMs: DEFAULT_REPLAY_SAFETY_MARGIN_MS,
  resolveRetryBaseDelayMs: 200,
  resolveRetryMaxDelayMs: 5_000,
});

/** Never start a resolution retry with less lease left than this (plus the retry delay). */
const RESOLVE_LEASE_MARGIN_MS = 1_000;

export interface ProcessDeliveryDeps {
  deliveries: DeliveryRepository;
  control: DeliveryControlRepository;
  providerConfig: ProviderConfigRepository;
  suppressions: SuppressionRepository;
  catalog: ProviderCatalog;
  secrets: SecretSource;
  rateLimiter: ProviderRateLimiter;
  breaker: ProviderCircuitBreaker;
  logger: DeliveryLogger;
  metrics?: Metrics;
  options?: Partial<ProcessDeliveryOptions>;
  clock?: () => Date;
  random?: RandomSource;
}

export type ProcessOutcome =
  /** Job obsolete: other generation, already resolved, or leased by another worker. */
  | 'stale'
  /** A fenced update matched nothing: another worker or the reconciler owns the delivery. */
  | 'fenced'
  | 'expired'
  | 'suppressed'
  /** Rescheduled without consuming an attempt. */
  | 'deferred'
  | 'accepted'
  | 'retry_scheduled'
  | 'fallback_scheduled'
  | 'failed'
  | 'unknown'
  /** A scheduled safe replay could not run safely any more. */
  | 'returned_to_unknown';

/**
 * Worker use case for one `dispatch_delivery` job. PostgreSQL is authoritative: the job only
 * carries references, and every state change is a fenced conditional update.
 */
export class ProcessDelivery {
  private readonly options: ProcessDeliveryOptions;
  private readonly clock: () => Date;
  private readonly random: RandomSource;
  private readonly resolver: ProviderResolver;
  private readonly metrics: Metrics;

  constructor(private readonly deps: ProcessDeliveryDeps) {
    this.options = { ...DEFAULT_PROCESS_DELIVERY_OPTIONS, ...deps.options };
    this.metrics = deps.metrics ?? noopMetrics;
    this.clock = deps.clock ?? (() => new Date());
    this.random = deps.random ?? Math.random;
    this.resolver = new ProviderResolver({
      providerConfig: deps.providerConfig,
      catalog: deps.catalog,
      secrets: deps.secrets,
      breaker: deps.breaker,
      logger: deps.logger,
      configurationQuarantineMs: this.options.configurationQuarantineMs,
    });
  }

  async execute(job: DeliveryJobData): Promise<ProcessOutcome> {
    const claimSentAt = performance.now();
    const claim = await this.deps.deliveries.claim(
      job.deliveryId,
      job.generation,
      this.options.leaseMs,
    );
    if (claim === null) {
      this.deps.logger.debug(
        {
          deliveryId: job.deliveryId,
          generation: job.generation,
          outboxEventId: job.outboxEventId,
        },
        'stale delivery job ignored',
      );
      return 'stale';
    }
    const lease = new LeaseKeeper({
      deliveries: this.deps.deliveries,
      logger: this.deps.logger,
      deliveryId: claim.deliveryId,
      leaseToken: claim.leaseToken,
      version: claim.version,
      leaseMs: this.options.leaseMs,
      renewEveryMs: this.options.leaseRenewIntervalMs ?? Math.floor(this.options.leaseMs / 3),
      claimSentAt,
    });
    try {
      return await this.process(claim, lease);
    } finally {
      lease.stop();
    }
  }

  private async process(claim: ClaimedDelivery, lease: LeaseKeeper): Promise<ProcessOutcome> {
    const now = this.clock();
    const history = await this.deps.control.attemptHistory(claim.tenantId, claim.deliveryId);
    const last = history.at(-1);
    // A runnable delivery whose latest attempt is ambiguous can only come from a scheduled safe
    // replay: the original call may have been accepted, so it never becomes expired, suppressed
    // or failed here (that would claim a certainty we don't have). It goes back to `unknown`
    // (operational queue, webhook/status evidence) and, if replayed, reuses the same provider
    // and key, never a fallback.
    const ambiguous = last?.outcome === 'unknown' ? last : null;

    if (isExpired(claim.expiresAt, now)) {
      return ambiguous === null
        ? this.terminal(claim, 'expired', 'delivery_expired')
        : this.backToUnknown(claim, 'replay_expired');
    }

    const suppressed = await this.deps.suppressions.isSuppressed(
      claim.tenantId,
      claim.payload.channel,
      recipientKey(claim.payload),
    );
    if (suppressed) {
      return ambiguous === null
        ? this.terminal(claim, 'suppressed', 'recipient_suppressed')
        : this.backToUnknown(claim, 'replay_suppressed');
    }

    if (!hasAttemptBudget(claim.attemptsUsed, claim.routing.maxAttempts)) {
      return ambiguous === null
        ? this.terminal(claim, 'failed', 'attempts_exhausted')
        : this.backToUnknown(claim, 'replay_budget_exhausted');
    }

    if (ambiguous !== null) return this.replay(claim, ambiguous, history, lease);
    return this.freshAttempt(claim, history, lease);
  }

  private async freshAttempt(
    claim: ClaimedDelivery,
    history: AttemptRecord[],
    lease: LeaseKeeper,
  ): Promise<ProcessOutcome> {
    const fallbackEnabled = fallbackEnabledOf(claim.routing);
    const order = candidateOrder(
      claim.routing.providerInstanceIds,
      excludedInstances(history),
      fallbackEnabled,
    );
    let temporaryDelayMs: number | null = null;

    for (const instanceId of order) {
      let candidate;
      try {
        candidate = await this.resolver.evaluate(
          claim.tenantId,
          instanceId,
          claim.payload,
          claim.routing,
        );
      } catch (error) {
        if (error instanceof BackendUnavailableError) return this.backendUnavailable(claim, error);
        throw error;
      }
      if (candidate.kind === 'selected') {
        const key = deriveProviderIdempotencyKey({
          tenantId: claim.tenantId,
          deliveryId: claim.deliveryId,
          deliveryCreatedAt: claim.createdAt,
          providerInstanceId: candidate.provider.record.id,
          operationAttemptNumber: claim.attemptsUsed + 1,
        });
        return this.attempt(claim, history, candidate.provider, key, false, lease);
      }
      const { reason } = candidate;
      this.deps.logger.info(
        { deliveryId: claim.deliveryId, providerInstanceId: instanceId, skip: reason.code },
        'provider candidate skipped',
      );
      if (reason.kind === 'temporary') {
        const delay = reason.retryAfterMs ?? this.options.noProviderDeferMs;
        temporaryDelayMs = temporaryDelayMs === null ? delay : Math.min(temporaryDelayMs, delay);
      }
    }

    if (temporaryDelayMs !== null) {
      return this.defer(claim, Math.max(temporaryDelayMs, 1), 'no_provider_available');
    }
    this.deps.logger.error(
      { alarm: 'no_eligible_provider', deliveryId: claim.deliveryId, tenantId: claim.tenantId },
      'no eligible provider for delivery',
    );
    return this.terminal(claim, 'failed', 'no_eligible_provider');
  }

  private async replay(
    claim: ClaimedDelivery,
    ambiguous: AttemptRecord,
    history: AttemptRecord[],
    lease: LeaseKeeper,
  ): Promise<ProcessOutcome> {
    let candidate;
    try {
      candidate = await this.resolver.evaluate(
        claim.tenantId,
        ambiguous.providerInstanceId,
        claim.payload,
        claim.routing,
        { requireIdempotency: true },
      );
    } catch (error) {
      if (error instanceof BackendUnavailableError) return this.backendUnavailable(claim, error);
      throw error;
    }
    if (candidate.kind === 'skipped') {
      if (candidate.reason.kind === 'temporary') {
        return this.defer(
          claim,
          candidate.reason.retryAfterMs ?? this.options.noProviderDeferMs,
          'replay_provider_unavailable',
        );
      }
      return this.backToUnknown(claim, 'replay_provider_unusable');
    }
    const keyFirstUsedAt = history
      .filter(
        (attempt) =>
          attempt.providerInstanceId === ambiguous.providerInstanceId &&
          attempt.providerIdempotencyKey === ambiguous.providerIdempotencyKey,
      )
      .reduce(
        (min, attempt) => (attempt.startedAt < min ? attempt.startedAt : min),
        ambiguous.startedAt,
      );
    const inWindow = isWithinReplayWindow(
      candidate.provider.adapter.capabilities,
      keyFirstUsedAt,
      this.clock(),
      this.options.replaySafetyMarginMs,
    );
    if (!inWindow) {
      await this.releaseProbe(candidate.provider);
      return this.backToUnknown(claim, 'replay_window_elapsed');
    }
    return this.attempt(
      claim,
      history,
      candidate.provider,
      ambiguous.providerIdempotencyKey,
      true,
      lease,
    );
  }

  private async attempt(
    claim: ClaimedDelivery,
    history: AttemptRecord[],
    provider: SelectedProvider,
    idempotencyKey: string,
    replay: boolean,
    lease: LeaseKeeper,
  ): Promise<ProcessOutcome> {
    // A half-open probe not followed by a send is given back (deferred, fenced, error), so the
    // breaker does not stay half-open until the probe TTL.
    let probeUsed = provider.probeToken === null;
    try {
      const started = await this.startSend(claim, provider, idempotencyKey);
      if (started.kind !== 'started') return started.outcome;
      probeUsed = true;
      return await this.sendAndRecord(
        claim,
        history,
        provider,
        idempotencyKey,
        replay,
        lease,
        started.attemptId,
      );
    } finally {
      if (!probeUsed) await this.releaseProbe(provider);
    }
  }

  /** Local quota, then attempt `started` + delivery `sending` persisted before the call. */
  private async startSend(
    claim: ClaimedDelivery,
    provider: SelectedProvider,
    idempotencyKey: string,
  ): Promise<
    { kind: 'started'; attemptId: number } | { kind: 'not_sent'; outcome: ProcessOutcome }
  > {
    const instanceId = provider.record.id;
    let quota;
    try {
      quota = await this.deps.rateLimiter.tryAcquire(
        instanceId,
        provider.record.limits.sendRateLimit,
      );
    } catch (error) {
      return {
        kind: 'not_sent',
        outcome: await this.backendUnavailable(
          claim,
          new BackendUnavailableError('rate_limiter', error),
        ),
      };
    }
    if (!quota.allowed) {
      return {
        kind: 'not_sent',
        outcome: await this.defer(
          claim,
          Math.max(quota.retryAfterMs, this.options.minRateLimitDeferMs),
          'rate_limited',
        ),
      };
    }

    const attemptId = await this.deps.deliveries.startAttempt(claim, {
      attemptNumber: claim.attemptsUsed + 1,
      providerInstanceId: instanceId,
      providerInstanceRevision: provider.record.revision,
      providerIdempotencyKey: idempotencyKey,
    });
    if (attemptId === null) {
      this.deps.logger.warn({ deliveryId: claim.deliveryId }, 'attempt start fenced out');
      return { kind: 'not_sent', outcome: 'fenced' };
    }
    return { kind: 'started', attemptId };
  }

  private async sendAndRecord(
    claim: ClaimedDelivery,
    history: AttemptRecord[],
    provider: SelectedProvider,
    idempotencyKey: string,
    replay: boolean,
    lease: LeaseKeeper,
    attemptId: number,
  ): Promise<ProcessOutcome> {
    const instanceId = provider.record.id;
    const attemptNumber = claim.attemptsUsed + 1;
    const channel = claim.payload.channel;
    const providerType = provider.record.providerType;
    if (claim.attemptsUsed === 0 && !replay) {
      const waited = (this.clock().getTime() - claim.createdAt.getTime()) / 1000;
      this.metrics.observeTimeToFirstAttempt(channel, Math.max(0, waited));
    }

    // The lease is renewed from the call until the outcome is recorded (including retries of
    // the recording after transient database errors).
    lease.start();
    const startedAt = performance.now();
    const raw = await this.callProvider(claim, provider, attemptId, idempotencyKey, lease);
    const callSeconds = (performance.now() - startedAt) / 1000;
    // On a replay a rejection does not prove the original call was not accepted (e.g. auth or
    // quota errors are raised before the provider looks at the idempotency key).
    const result: SendResult =
      replay && raw.outcome === 'rejected'
        ? { outcome: 'unknown', reason: `replay_rejected:${raw.error.code}` }
        : raw;
    this.metrics.observeProviderCall(providerType, result.outcome, callSeconds);
    await this.feedBreaker(provider, result);

    const now = this.clock();
    const fallbackEligible =
      result.outcome === 'rejected' &&
      isFallbackEligible({
        error: result.error,
        currentInstanceId: instanceId,
        snapshotInstanceIds: claim.routing.providerInstanceIds,
        history,
        fallbackEnabled: fallbackEnabledOf(claim.routing),
        attemptsUsed: attemptNumber,
        maxAttempts: claim.routing.maxAttempts,
      });
    const decision = decideAfterSend({
      result,
      attemptsUsed: attemptNumber,
      maxAttempts: claim.routing.maxAttempts,
      now,
      expiresAt: claim.expiresAt,
      receiptsSupported: provider.adapter.capabilities.receipts,
      fallbackEligible,
      policy: this.options.retryPolicy,
      random: this.random,
    });

    const logContext = {
      deliveryId: claim.deliveryId,
      tenantId: claim.tenantId,
      attemptNumber,
      providerInstanceId: instanceId,
      providerType,
      replay,
      durationMs: Math.round(callSeconds * 1000),
      outcome: result.outcome,
      errorCode: result.outcome === 'rejected' ? result.error.code : undefined,
      decision: decision.kind,
    };
    if (result.outcome === 'rejected' && result.error.kind === 'configuration') {
      this.deps.logger.error(
        { ...logContext, alarm: 'provider_configuration_error', fallback: fallbackEligible },
        'provider rejected the send for a configuration problem',
      );
    } else if (decision.kind === 'unknown') {
      this.deps.logger.warn(logContext, 'ambiguous provider result: delivery is unknown');
    } else {
      this.deps.logger.info(logContext, 'provider attempt resolved');
    }

    const resolved = await this.recordResolution(claim, attemptId, toResolution(decision), lease);
    if (!resolved) {
      this.deps.logger.warn(
        { deliveryId: claim.deliveryId, attemptId, outcome: result.outcome },
        'attempt resolution fenced out (lease lost): newer state kept',
      );
      return 'fenced';
    }
    this.recordDecision(decision, channel, providerType);
    return outcomeOf(decision);
  }

  /**
   * Records the outcome of a provider call. A transient database error is retried with a short
   * backoff while the lease is still valid (it keeps being renewed meanwhile): otherwise an
   * accepted send would end as `unknown` once the lease expires, permanently for providers
   * without idempotency. A fenced update (lease lost) is final and never retried.
   */
  private async recordResolution(
    claim: ClaimedDelivery,
    attemptId: number,
    resolution: AttemptResolution,
    lease: LeaseKeeper,
  ): Promise<boolean> {
    let delay = this.options.resolveRetryBaseDelayMs;
    let failedBefore = false;
    for (;;) {
      try {
        const applied = await this.deps.deliveries.resolveAttempt(claim, attemptId, resolution);
        if (applied || !failedBefore) return applied;
        // An earlier try may have committed before its error reached us (e.g. connection lost
        // after COMMIT): the update is then fenced although our outcome is the recorded one.
        return await this.alreadyRecorded(claim, attemptId, resolution);
      } catch (error) {
        const remaining = lease.remainingMs();
        if (lease.lost || remaining <= delay + RESOLVE_LEASE_MARGIN_MS) {
          this.deps.logger.error(
            {
              deliveryId: claim.deliveryId,
              attemptId,
              outcome: resolution.outcome,
              err: errorMessage(error),
            },
            'attempt outcome could not be recorded before the lease expiry',
          );
          throw error;
        }
        failedBefore = true;
        this.deps.logger.warn(
          {
            deliveryId: claim.deliveryId,
            attemptId,
            outcome: resolution.outcome,
            retryInMs: delay,
            err: errorMessage(error),
          },
          'recording the attempt outcome failed: retrying while the lease is valid',
        );
        await sleep(delay);
        delay = Math.min(delay * 2, this.options.resolveRetryMaxDelayMs);
      }
    }
  }

  private async alreadyRecorded(
    claim: ClaimedDelivery,
    attemptId: number,
    resolution: AttemptResolution,
  ): Promise<boolean> {
    try {
      const history = await this.deps.control.attemptHistory(claim.tenantId, claim.deliveryId);
      const attempt = history.find((record) => record.attemptId === attemptId);
      return attempt?.outcome === resolution.outcome;
    } catch {
      return false;
    }
  }

  /** Called only once the resolution was applied (never for fenced updates). */
  private recordDecision(decision: SendDecision, channel: Channel, providerType: string): void {
    switch (decision.kind) {
      case 'accepted':
        this.metrics.finalOutcome(channel, 'accepted');
        break;
      case 'unknown':
        this.metrics.unknownTransition('ambiguous_result');
        break;
      case 'retry':
        if (decision.fallback) this.metrics.fallbackTaken(channel, providerType);
        else this.metrics.retryScheduled(channel, providerType);
        break;
      case 'fail':
        this.metrics.finalOutcome(channel, 'failed');
        break;
    }
  }

  private async callProvider(
    claim: ClaimedDelivery,
    provider: SelectedProvider,
    attemptId: number,
    idempotencyKey: string,
    lease: LeaseKeeper,
  ): Promise<SendResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new Error('send timeout'));
    }, this.options.sendTimeoutMs);
    // A lost lease aborts the call before submission if still possible.
    const signal = AbortSignal.any([controller.signal, lease.signal]);

    const payload = claim.payload;
    const body = {
      recipient: payload.recipient,
      content: payload.content,
    } as PayloadByChannel[Channel];
    try {
      return await provider.adapter.send(body, {
        deliveryId: claim.deliveryId,
        createdAt: claim.createdAt,
        attemptId,
        instance: provider.instance,
        idempotencyKey,
        signal,
      });
    } catch (error) {
      // Adapters must not throw; if one does, nothing proves the message was not accepted.
      this.deps.logger.error(
        { deliveryId: claim.deliveryId, err: errorMessage(error) },
        'provider adapter threw',
      );
      return { outcome: 'unknown', reason: 'adapter_exception' };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async feedBreaker(provider: SelectedProvider, result: SendResult): Promise<void> {
    const record = provider.record;
    const instanceId = record.id;
    try {
      switch (breakerSignal(result)) {
        case 'success':
          await this.deps.breaker.recordSuccess(instanceId, provider.probeToken ?? undefined);
          break;
        case 'failure':
          await this.deps.breaker.recordFailure(instanceId, record.limits.circuitBreaker);
          break;
        case 'quarantine':
          await this.deps.breaker.forceOpen(instanceId, this.options.configurationQuarantineMs);
          break;
      }
    } catch (error) {
      // The outcome must still be recorded: breaker bookkeeping is best effort.
      this.deps.logger.warn(
        { providerInstanceId: instanceId, err: errorMessage(error) },
        'circuit breaker update failed',
      );
    }
  }

  private async releaseProbe(provider: SelectedProvider): Promise<void> {
    if (provider.probeToken === null) return;
    try {
      await this.deps.breaker.releaseProbe(provider.record.id, provider.probeToken);
    } catch (error) {
      // Best effort: the probe lease expires on its own.
      this.deps.logger.warn(
        { providerInstanceId: provider.record.id, err: errorMessage(error) },
        'circuit breaker probe release failed',
      );
    }
  }

  private async terminal(
    claim: ClaimedDelivery,
    status: 'failed' | 'suppressed' | 'expired',
    reason: string,
  ): Promise<ProcessOutcome> {
    const ok = await this.deps.deliveries.markTerminal(claim, status, reason);
    this.deps.logger.info(
      { deliveryId: claim.deliveryId, tenantId: claim.tenantId, status, reason, applied: ok },
      'delivery closed before sending',
    );
    if (ok) this.metrics.finalOutcome(claim.payload.channel, status);
    return ok ? status : 'fenced';
  }

  private async defer(
    claim: ClaimedDelivery,
    delayMs: number,
    reason: string,
  ): Promise<ProcessOutcome> {
    // The repository applies the delay on the database clock, never past the expiry (the next
    // claim then closes the delivery as expired).
    const ok = await this.deps.control.defer(claim, delayMs, reason);
    this.deps.logger.info(
      { deliveryId: claim.deliveryId, reason, retryInMs: Math.round(delayMs), applied: ok },
      'delivery deferred without consuming an attempt',
    );
    return ok ? 'deferred' : 'fenced';
  }

  private backendUnavailable(
    claim: ClaimedDelivery,
    error: BackendUnavailableError,
  ): Promise<ProcessOutcome> {
    this.deps.logger.error(
      {
        alarm: `${error.backend}_unavailable`,
        deliveryId: claim.deliveryId,
        err: errorMessage(error.cause),
      },
      'shared limit backend unavailable: sending suspended',
    );
    return this.defer(
      claim,
      this.options.backendUnavailableDeferMs,
      `${error.backend}_unavailable`,
    );
  }

  private async backToUnknown(claim: ClaimedDelivery, reason: string): Promise<ProcessOutcome> {
    const ok = await this.deps.control.returnToUnknown(claim, reason);
    this.deps.logger.warn(
      { deliveryId: claim.deliveryId, reason, applied: ok },
      'safe replay abandoned',
    );
    if (ok) this.metrics.unknownTransition('replay_abandoned');
    return ok ? 'returned_to_unknown' : 'fenced';
  }
}

function toResolution(decision: SendDecision): AttemptResolution {
  switch (decision.kind) {
    case 'accepted':
      return {
        outcome: 'accepted',
        externalReference: decision.externalReference,
        receiptStatus: decision.receiptStatus,
      };
    case 'unknown':
      return {
        outcome: 'unknown',
        reason: decision.reason,
        externalReference: decision.externalReference,
      };
    case 'retry':
      return {
        outcome: 'rejected',
        error: decision.error,
        next: { kind: 'retry', at: decision.at },
      };
    case 'fail':
      // The repository owns the budget: asking for a retry with an exhausted budget records
      // terminal_reason 'attempts_exhausted' atomically.
      return decision.reason === 'attempts_exhausted'
        ? { outcome: 'rejected', error: decision.error, next: { kind: 'retry', at: new Date() } }
        : { outcome: 'rejected', error: decision.error, next: { kind: 'fail' } };
  }
}

function outcomeOf(decision: SendDecision): ProcessOutcome {
  switch (decision.kind) {
    case 'accepted':
      return 'accepted';
    case 'unknown':
      return 'unknown';
    case 'retry':
      return decision.fallback ? 'fallback_scheduled' : 'retry_scheduled';
    case 'fail':
      return 'failed';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
