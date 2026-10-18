import { dispatchJobId } from '../../contracts/jobs.js';
import { noopMetrics, type Metrics } from '../ports/metrics.js';
import type { ClaimedOutboxEvent, OutboxRepository } from '../ports/repositories.js';
import { QueuePublishError, type DeliveryJobPublisher, type DeliveryLogger } from './ports.js';

export interface DispatchOutboxOptions {
  batchSize: number;
  /** Outbox lease: a crashed dispatcher's events become claimable again after it. */
  leaseMs: number;
  /** Delay before re-publishing after a queue failure (grows with the dispatch count). */
  retryBaseMs: number;
  retryMaxMs: number;
  /** Events for a channel without a queue are parked for this long. */
  unroutableRetryMs: number;
  /**
   * Deadline of one publication (`QUEUE_PUBLISH_TIMEOUT_MS`). A batch stops publishing once
   * less than this is left of the outbox lease, releasing the remaining events: a publication
   * never starts after its event could have been re-claimed by another dispatcher.
   */
  publishTimeoutMs: number;
}

export const DEFAULT_DISPATCH_OUTBOX_OPTIONS: DispatchOutboxOptions = Object.freeze({
  batchSize: 100,
  leaseMs: 30_000,
  retryBaseMs: 1_000,
  retryMaxMs: 30_000,
  unroutableRetryMs: 3600_000,
  publishTimeoutMs: 3_000,
});

export interface DispatchReport {
  claimed: number;
  published: number;
  released: number;
  /** Published but the ack missed the lease (another dispatcher re-claimed it). */
  ackLost: number;
  /** Released unpublished because the batch ran out of outbox lease time (due again now). */
  yielded: number;
}

/**
 * Outbox -> queue publication. Claims due events (FOR UPDATE SKIP LOCKED in the repository),
 * publishes outside any transaction with job id `dispatch-<outboxId>-<dispatchCount>` and
 * references only, and acknowledges only after the queue confirmed the job. Any publication
 * failure leaves the event re-publishable through `releaseAfterError`.
 */
export class DispatchOutbox {
  private readonly options: DispatchOutboxOptions;

  constructor(
    private readonly deps: {
      outbox: OutboxRepository;
      publisher: DeliveryJobPublisher;
      logger: DeliveryLogger;
      metrics?: Metrics;
      options?: Partial<DispatchOutboxOptions>;
      /** Monotonic milliseconds (tests); defaults to `performance.now()`. */
      monotonicMs?: () => number;
    },
  ) {
    this.options = { ...DEFAULT_DISPATCH_OUTBOX_OPTIONS, ...deps.options };
    this.metrics = deps.metrics ?? noopMetrics;
  }

  private readonly metrics: Metrics;

  private elapsedSince(start: number): number {
    return (this.deps.monotonicMs?.() ?? performance.now()) - start;
  }

  async runOnce(): Promise<DispatchReport> {
    const report: DispatchReport = {
      claimed: 0,
      published: 0,
      released: 0,
      ackLost: 0,
      yielded: 0,
    };
    // Started before the claim: the lease began no later than this instant.
    const start = this.deps.monotonicMs?.() ?? performance.now();
    const budgetMs = Math.max(0, this.options.leaseMs - this.options.publishTimeoutMs);
    const events = await this.deps.outbox.claimAvailable(
      this.options.batchSize,
      this.options.leaseMs,
    );
    report.claimed = events.length;
    let queueDown: QueuePublishError | null = null;

    for (const [index, event] of events.entries()) {
      if (this.elapsedSince(start) >= budgetMs) {
        await this.yieldRemaining(events.slice(index), report);
        break;
      }
      if (queueDown !== null) {
        // Fail the rest of the batch fast instead of waiting one timeout per event.
        await this.release(event, queueDown, report);
        continue;
      }
      try {
        await this.deps.publisher.publish(
          event.channel,
          dispatchJobId(event.id, event.dispatchCount),
          {
            deliveryId: event.deliveryId,
            generation: event.generation,
            outboxEventId: event.id,
          },
        );
      } catch (error) {
        const publishError =
          error instanceof QueuePublishError
            ? error
            : new QueuePublishError('publish_failed', errorMessage(error));
        if (publishError.code !== 'no_queue') queueDown = publishError;
        await this.release(event, publishError, report);
        continue;
      }
      const acked = await this.deps.outbox.markPublished(event.id, event.leaseToken);
      if (acked) {
        report.published += 1;
      } else {
        report.ackLost += 1;
        this.deps.logger.warn(
          { outboxEventId: event.id, deliveryId: event.deliveryId },
          'outbox ack lost: event was re-claimed or deferred meanwhile',
        );
      }
    }

    this.metrics.outboxPublished(report.published);
    if (report.yielded > 0) {
      this.deps.logger.warn(
        { yielded: report.yielded, published: report.published, budgetMs },
        'outbox batch ran out of lease time: remaining events released',
      );
    }
    if (queueDown !== null) {
      this.deps.logger.error(
        { alarm: 'queue_publish_failed', code: queueDown.code, released: report.released },
        'queue publication failed: outbox events left re-publishable',
      );
    }
    return report;
  }

  /** Unpublished events go back to 'pending', due now (no failure: the queue is fine). */
  private async yieldRemaining(
    events: readonly ClaimedOutboxEvent[],
    report: DispatchReport,
  ): Promise<void> {
    for (const event of events) {
      try {
        const released = await this.deps.outbox.releaseAfterError(
          event.id,
          event.leaseToken,
          'batch_time_budget: outbox lease nearly elapsed before publication',
          0,
        );
        if (released) report.yielded += 1;
      } catch (error) {
        // The outbox lease expires on its own: the event is re-claimed after `leaseMs`.
        this.deps.logger.error(
          { outboxEventId: event.id, err: errorMessage(error) },
          'outbox release failed',
        );
      }
    }
  }

  private async release(
    event: ClaimedOutboxEvent,
    error: QueuePublishError,
    report: DispatchReport,
  ): Promise<void> {
    this.metrics.outboxPublishFailed(error.code, 1);
    const delay =
      error.code === 'no_queue'
        ? this.options.unroutableRetryMs
        : Math.min(
            this.options.retryMaxMs,
            this.options.retryBaseMs * 2 ** Math.min(Math.max(event.dispatchCount - 1, 0), 10),
          );
    try {
      const released = await this.deps.outbox.releaseAfterError(
        event.id,
        event.leaseToken,
        `${error.code}: ${error.message}`,
        delay,
      );
      if (released) report.released += 1;
    } catch (releaseError) {
      // The outbox lease expires on its own: the event is re-claimed after `leaseMs`.
      this.deps.logger.error(
        { outboxEventId: event.id, err: errorMessage(releaseError) },
        'outbox release failed',
      );
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
