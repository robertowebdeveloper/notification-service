import { recipientKey } from '../../domain/recipient.js';
import { receiptEffect, receiptTransition } from '../../domain/receipt-reducer.js';
import type {
  DeliveryReceiptRepository,
  ProviderEventRepository,
  StoredProviderEvent,
  SuppressionRepository,
} from '../ports/lookup-repositories.js';
import type { DeliveryControlRepository } from '../ports/delivery-control.js';
import { noopMetrics, type Metrics } from '../ports/metrics.js';
import type { DeliveryLogger } from './ports.js';

export interface ProviderEventOptions {
  batchSize: number;
  /** Uncorrelated events older than this are closed as orphans (never correlated). */
  orphanAfterMs: number;
}

export const DEFAULT_PROVIDER_EVENT_OPTIONS: ProviderEventOptions = Object.freeze({
  batchSize: 200,
  orphanAfterMs: 3600_000,
});

export interface ProviderEventReport {
  correlated: number;
  processed: number;
  orphaned: number;
}

/**
 * Applies durable webhook events (`provider_events`) to deliveries with the deterministic
 * receipt reducer. Every step is idempotent (compare-and-set receipt, idempotent suppression,
 * conditional unknown -> accepted, processed flag), so a crash between steps is repaired by
 * re-processing the event. Events never trigger a new send.
 */
export class ProcessProviderEvents {
  private readonly options: ProviderEventOptions;

  constructor(
    private readonly deps: {
      events: ProviderEventRepository;
      receipts: DeliveryReceiptRepository;
      suppressions: SuppressionRepository;
      control: DeliveryControlRepository;
      logger: DeliveryLogger;
      metrics?: Metrics;
      options?: Partial<ProviderEventOptions>;
      clock?: () => Date;
    },
  ) {
    this.options = { ...DEFAULT_PROVIDER_EVENT_OPTIONS, ...deps.options };
  }

  private now(): Date {
    return this.deps.clock?.() ?? new Date();
  }

  async runOnce(): Promise<ProviderEventReport> {
    const report: ProviderEventReport = { correlated: 0, processed: 0, orphaned: 0 };
    report.correlated = await this.deps.events.correlatePending(this.options.batchSize);
    // Correlated events have their own query: a backlog of uncorrelated events (waiting for the
    // attempt that carries their message id) can never starve them.
    const correlated = await this.deps.events.findUnprocessedCorrelated(this.options.batchSize);
    for (const event of correlated) {
      if (event.deliveryId === null) continue;
      if (await this.apply(event, event.deliveryId)) report.processed += 1;
    }

    const now = this.now();
    const orphans = await this.deps.events.findUncorrelatedReceivedBefore(
      new Date(now.getTime() - this.options.orphanAfterMs),
      this.options.batchSize,
    );
    for (const event of orphans) {
      if (event.deliveryId !== null) continue;
      if (await this.deps.events.markProcessed(event.tenantId, event.id, now)) {
        report.orphaned += 1;
        this.deps.logger.warn(
          {
            providerEventId: event.id,
            providerInstanceId: event.providerInstanceId,
            type: event.type,
          },
          'provider event never correlated to a delivery: closed as orphan',
        );
      }
    }
    return report;
  }

  /**
   * Returns false when the event was left unprocessed to be applied on a later run: acceptance
   * evidence for a delivery whose (replay) attempt is in flight must not be dropped, since that
   * attempt may still end ambiguous.
   */
  private async apply(event: StoredProviderEvent, deliveryId: number): Promise<boolean> {
    const target = await this.deps.control.findTarget(event.tenantId, deliveryId);
    if (target !== null) {
      const effect = receiptEffect(event.type);
      if (effect.provesAcceptance && target.submissionStatus === 'sending') {
        this.deps.logger.info(
          { deliveryId, providerEventId: event.id, type: event.type },
          'acceptance evidence for a delivery being sent: applied on a later run',
        );
        return false;
      }
      // `retry_wait` too: a safe replay of an ambiguous attempt may be scheduled; the
      // repository only resolves it when the latest attempt is the ambiguous one.
      if (
        effect.provesAcceptance &&
        (target.submissionStatus === 'unknown' || target.submissionStatus === 'retry_wait')
      ) {
        const resolved = await this.deps.control.resolveUnknownAccepted(
          event.tenantId,
          deliveryId,
          null,
          'pending',
          event.externalMessageId,
        );
        if (resolved) {
          (this.deps.metrics ?? noopMetrics).finalOutcome(target.channel, 'accepted');
          this.deps.logger.info(
            { deliveryId, providerEventId: event.id, type: event.type },
            'unknown delivery resolved as accepted from provider event',
          );
        }
      }
      const transition = receiptTransition(event.type);
      if (transition !== null) {
        await this.deps.receipts.updateReceiptStatus(
          event.tenantId,
          deliveryId,
          transition.from,
          transition.to,
        );
      }
      if (effect.suppression !== null) {
        const created = await this.deps.suppressions.add({
          tenantId: event.tenantId,
          channel: target.channel,
          recipientKey: recipientKey(target.payload),
          reason: effect.suppression,
          source: 'provider_event',
          providerEventId: event.id,
        });
        if (created) {
          this.deps.logger.info(
            { deliveryId, providerEventId: event.id, reason: effect.suppression },
            'recipient suppressed from provider event',
          );
        }
      }
    }
    await this.deps.events.markProcessed(event.tenantId, event.id, this.now());
    return true;
  }
}
