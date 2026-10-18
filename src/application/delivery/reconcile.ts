import { isWithinReplayWindow, safeReplayDeadline } from '../../domain/idempotency.js';
import { receiptTransition } from '../../domain/receipt-reducer.js';
import {
  computeBackoffMs,
  DEFAULT_RETRY_POLICY,
  hasAttemptBudget,
  type RandomSource,
  type RetryPolicy,
} from '../../domain/retry-policy.js';
import { DEFAULT_REPLAY_SAFETY_MARGIN_MS } from '../../domain/idempotency.js';
import type {
  DeliveryReceiptRepository,
  ProviderConfigRepository,
} from '../ports/lookup-repositories.js';
import { noopMetrics, type Metrics } from '../ports/metrics.js';
import type {
  DeliveryRepository,
  LostPublicationCandidate,
  OutboxRepository,
} from '../ports/repositories.js';
import type { DeliveryControlRepository, UnknownDelivery } from '../ports/delivery-control.js';
import { dispatchJobId } from '../../contracts/jobs.js';
import type {
  DeliveryJobInspector,
  DeliveryLogger,
  ProviderCatalog,
  ProviderCircuitBreaker,
  SecretSource,
} from './ports.js';
import type { ProcessProviderEvents, ProviderEventReport } from './process-provider-events.js';
import { ProviderResolver } from './provider-selection.js';

export interface ReconcileOptions {
  batchSize: number;
  /**
   * Published events whose job produced no activity for this long are re-armed (job lost).
   * Must exceed the normal queue latency: a re-armed event only creates a harmless duplicate.
   */
  lostPublicationAfterMs: number;
  /** Minimum interval between two reconciliation checks of the same unknown delivery. */
  unknownCheckIntervalMs: number;
  /** Wait after an ambiguous attempt before replaying it (lets webhooks arrive first). */
  replayDelayMs: number;
  replaySafetyMarginMs: number;
  statusQueryTimeoutMs: number;
  retryPolicy: RetryPolicy;
}

export const DEFAULT_RECONCILE_OPTIONS: ReconcileOptions = Object.freeze({
  batchSize: 100,
  lostPublicationAfterMs: 5 * 60_000,
  unknownCheckIntervalMs: 60_000,
  replayDelayMs: 30_000,
  replaySafetyMarginMs: DEFAULT_REPLAY_SAFETY_MARGIN_MS,
  statusQueryTimeoutMs: 10_000,
  retryPolicy: DEFAULT_RETRY_POLICY,
});

export interface ReconcileReport {
  rearmed: number;
  /** Lost-publication candidates whose job is still waiting/delayed/active in the queue. */
  rearmSkippedQueued: number;
  staleToUnknown: number;
  unknownChecked: number;
  unknownAccepted: number;
  replaysScheduled: number;
  events: ProviderEventReport | null;
}

/** Status queries never need the breaker; a permissive one keeps the resolver contract. */
const UNUSED_BREAKER: ProviderCircuitBreaker = {
  acquire: () => Promise.resolve({ allowed: true, probe: false }),
  recordSuccess: () => Promise.resolve(),
  recordFailure: () => Promise.resolve(),
  forceOpen: () => Promise.resolve(),
  releaseProbe: () => Promise.resolve(),
};

/**
 * Periodic recovery run by the dispatcher:
 * 1. re-arm published events whose job was lost (new job id through dispatch_count); a candidate
 *    whose job is still waiting/delayed/active in the queue is a slow queue, not a lost job, and
 *    is left alone; when the queue cannot be inspected nothing is re-armed this cycle (the
 *    dispatcher cannot publish either, and the check is repeated on the next cycle);
 * 2. move `sending` deliveries with an expired lease to `unknown` (never re-send directly);
 * 3. resolve `unknown` deliveries: status query when the adapter supports it (accepted ->
 *    `accepted`); otherwise, or when the provider does not know the message, schedule a safe
 *    replay only through the same provider with the same idempotency key inside its window
 *    (minus a safety margin) and within budget and expiry. Providers without idempotency
 *    (generic SMTP) stay `unknown`: the operational queue for manual follow-up;
 * 4. apply webhook events with the receipt reducer.
 */
export class Reconcile {
  private readonly options: ReconcileOptions;
  private readonly resolver: ProviderResolver;
  private readonly metrics: Metrics;

  constructor(
    private readonly deps: {
      outbox: OutboxRepository;
      deliveries: DeliveryRepository;
      control: DeliveryControlRepository;
      providerConfig: ProviderConfigRepository;
      receipts: DeliveryReceiptRepository;
      catalog: ProviderCatalog;
      secrets: SecretSource;
      providerEvents?: ProcessProviderEvents;
      /** Queue view used to skip candidates whose job still exists; without it all are re-armed. */
      jobs?: DeliveryJobInspector;
      /** Called whenever the run makes progress (loop watchdog heartbeat). */
      onProgress?: () => void;
      logger: DeliveryLogger;
      metrics?: Metrics;
      options?: Partial<ReconcileOptions>;
      clock?: () => Date;
      random?: RandomSource;
    },
  ) {
    this.options = { ...DEFAULT_RECONCILE_OPTIONS, ...deps.options };
    this.metrics = deps.metrics ?? noopMetrics;
    this.resolver = new ProviderResolver({
      providerConfig: deps.providerConfig,
      catalog: deps.catalog,
      secrets: deps.secrets,
      breaker: UNUSED_BREAKER,
      logger: deps.logger,
      configurationQuarantineMs: 0,
    });
  }

  private now(): Date {
    return this.deps.clock?.() ?? new Date();
  }

  private progress(): void {
    this.deps.onProgress?.();
  }

  async runOnce(): Promise<ReconcileReport> {
    const report: ReconcileReport = {
      rearmed: 0,
      rearmSkippedQueued: 0,
      staleToUnknown: 0,
      unknownChecked: 0,
      unknownAccepted: 0,
      replaysScheduled: 0,
      events: null,
    };
    await this.step('rearm_lost_publications', async () => {
      await this.rearmLostPublications(report);
    });
    await this.step('stale_sending', async () => {
      report.staleToUnknown = await this.deps.deliveries.markStaleSendingUnknown(
        this.options.batchSize,
      );
      this.metrics.unknownTransition('stale_lease', report.staleToUnknown);
      if (report.staleToUnknown > 0) {
        this.deps.logger.warn(
          { count: report.staleToUnknown },
          'sending deliveries with expired lease moved to unknown',
        );
      }
    });
    await this.step('unknown_resolution', async () => {
      const unknown = await this.deps.control.findUnknown(
        this.options.unknownCheckIntervalMs,
        this.options.batchSize,
      );
      this.progress();
      for (const delivery of unknown) {
        report.unknownChecked += 1;
        const result = await this.resolveUnknown(delivery);
        if (result === 'accepted') report.unknownAccepted += 1;
        if (result === 'replay') report.replaysScheduled += 1;
        this.progress();
      }
    });
    const events = this.deps.providerEvents;
    if (events !== undefined) {
      await this.step('provider_events', async () => {
        report.events = await events.runOnce();
      });
    }
    this.recordMetrics(report);
    return report;
  }

  private recordMetrics(report: ReconcileReport): void {
    this.metrics.reconciliation('rearmed', report.rearmed);
    this.metrics.reconciliation('stale_to_unknown', report.staleToUnknown);
    this.metrics.reconciliation('unknown_checked', report.unknownChecked);
    this.metrics.reconciliation('unknown_accepted', report.unknownAccepted);
    this.metrics.reconciliation('replay_scheduled', report.replaysScheduled);
    if (report.events !== null) {
      this.metrics.reconciliation('events_processed', report.events.processed);
      this.metrics.reconciliation('events_orphaned', report.events.orphaned);
    }
  }

  private async rearmLostPublications(report: ReconcileReport): Promise<void> {
    const candidates = await this.deps.outbox.findLostPublications(
      this.options.lostPublicationAfterMs,
      this.options.batchSize,
    );
    if (candidates.length === 0) return;
    const jobs = this.deps.jobs;
    let lost: LostPublicationCandidate[] = candidates;
    if (jobs !== undefined) {
      lost = [];
      for (const candidate of candidates) {
        let pending: boolean;
        try {
          pending = await jobs.isJobPending(
            candidate.channel,
            dispatchJobId(candidate.id, candidate.dispatchCount),
          );
        } catch (error) {
          // Valkey unavailable: re-arming blindly would only pile up duplicates once it is back
          // (and nothing can be published meanwhile). Retry on the next cycle.
          this.deps.logger.warn(
            { err: error instanceof Error ? error.message : String(error) },
            'queue not inspectable: lost publications not re-armed this cycle',
          );
          return;
        }
        if (pending) report.rearmSkippedQueued += 1;
        else lost.push(candidate);
      }
      this.progress();
    }
    if (lost.length === 0) return;
    report.rearmed = await this.deps.outbox.rearmPublications(lost);
    if (report.rearmed > 0) {
      this.deps.logger.warn({ count: report.rearmed }, 'lost outbox publications re-armed');
    }
  }

  private async step(name: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
      this.progress();
    } catch (error) {
      this.metrics.reconciliation('step_failed', 1);
      this.deps.logger.error(
        { step: name, err: error instanceof Error ? error.message : String(error) },
        'reconciliation step failed',
      );
    }
  }

  private async resolveUnknown(delivery: UnknownDelivery): Promise<'accepted' | 'replay' | 'left'> {
    const { tenantId, deliveryId, lastAttempt } = delivery;
    const record = await this.deps.providerConfig.findProviderInstance(
      tenantId,
      lastAttempt.providerInstanceId,
    );
    const adapter =
      record === null
        ? undefined
        : this.deps.catalog.forChannel(record.providerType, record.channel);
    if (record === null || adapter === undefined) {
      await this.deps.control.touchUnknown(tenantId, deliveryId, delivery.version);
      return 'left';
    }
    const capabilities = adapter.capabilities;

    if (
      capabilities.statusQuery &&
      adapter.getStatus !== undefined &&
      lastAttempt.externalReference !== null
    ) {
      const resolved = await this.resolver.resolveInstance(record, adapter);
      if (!resolved.ok) {
        await this.deps.control.touchUnknown(tenantId, deliveryId, delivery.version);
        return 'left';
      }
      let status;
      try {
        status = await adapter.getStatus(
          lastAttempt.externalReference,
          resolved.instance,
          AbortSignal.timeout(this.options.statusQueryTimeoutMs),
        );
      } catch (error) {
        this.deps.logger.warn(
          {
            deliveryId,
            providerInstanceId: record.id,
            code: (error as { code?: unknown }).code,
          },
          'status query failed: delivery stays unknown',
        );
        await this.deps.control.touchUnknown(tenantId, deliveryId, delivery.version);
        return 'left';
      }
      if (status.found && status.accepted) {
        const accepted = await this.deps.control.resolveUnknownAccepted(
          tenantId,
          deliveryId,
          delivery.version,
          capabilities.receipts ? 'pending' : 'unavailable',
          lastAttempt.externalReference,
        );
        const transition = status.receipt === undefined ? null : receiptTransition(status.receipt);
        if (accepted && transition !== null) {
          await this.deps.receipts.updateReceiptStatus(
            tenantId,
            deliveryId,
            transition.from,
            transition.to,
          );
        }
        if (accepted) this.metrics.finalOutcome(record.channel, 'accepted');
        this.deps.logger.info(
          { deliveryId, providerInstanceId: record.id, applied: accepted },
          'unknown delivery resolved as accepted by status query',
        );
        return accepted ? 'accepted' : 'left';
      }
      if (status.found) {
        // Known to the provider but not accepted: not a certain rejection of the original
        // call semantics we can rely on; keep it in the operational queue.
        await this.deps.control.touchUnknown(tenantId, deliveryId, delivery.version);
        return 'left';
      }
      // Not found: fall through to the safe replay policy.
    }

    const now = this.now();
    const lastActivity = lastAttempt.finishedAt ?? lastAttempt.startedAt;
    const settled = now.getTime() - lastActivity.getTime() >= this.options.replayDelayMs;
    const margin = this.options.replaySafetyMarginMs;
    const replayable =
      settled &&
      hasAttemptBudget(delivery.attemptsUsed, delivery.maxAttempts) &&
      now.getTime() < delivery.expiresAt.getTime() &&
      isWithinReplayWindow(capabilities, delivery.keyFirstUsedAt, now, margin);
    if (replayable) {
      const deadline = safeReplayDeadline(capabilities, delivery.keyFirstUsedAt, margin);
      const delay = computeBackoffMs(
        delivery.attemptsUsed,
        this.options.retryPolicy,
        this.deps.random ?? Math.random,
      );
      const at = new Date(now.getTime() + delay);
      if (deadline !== null && at < deadline && at < delivery.expiresAt) {
        const scheduled = await this.deps.control.scheduleSafeReplay(
          tenantId,
          deliveryId,
          delivery.version,
          at,
        );
        this.deps.logger.info(
          {
            deliveryId,
            providerInstanceId: record.id,
            retryAt: at.toISOString(),
            applied: scheduled,
          },
          'safe replay scheduled for unknown delivery (same provider, same idempotency key)',
        );
        if (scheduled) return 'replay';
      }
    }
    await this.deps.control.touchUnknown(tenantId, deliveryId, delivery.version);
    return 'left';
  }
}
