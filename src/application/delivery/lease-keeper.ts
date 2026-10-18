import type { DeliveryRepository } from '../ports/repositories.js';
import type { DeliveryLogger } from './ports.js';

/**
 * Keeps a worker's delivery lease alive while a provider call and the recording of its outcome
 * are in progress, and tracks a conservative local view of how long the lease is still valid.
 *
 * The lease itself is set and compared by PostgreSQL (`now() + interval`); locally only a
 * monotonic clock is used: the validity starts when the claim/renewal request was *sent*, so the
 * local estimate always ends before the database lease does.
 */
export class LeaseKeeper {
  private validUntil: number;
  private timer: NodeJS.Timeout | undefined;
  private renewing = false;
  private readonly controller = new AbortController();

  constructor(
    private readonly deps: {
      deliveries: DeliveryRepository;
      logger: DeliveryLogger;
      deliveryId: string;
      leaseToken: string;
      version: number;
      leaseMs: number;
      /** 0 disables renewal (tests only). */
      renewEveryMs: number;
      /** `performance.now()` taken just before the claim request was sent. */
      claimSentAt: number;
    },
  ) {
    this.validUntil = deps.claimSentAt + deps.leaseMs;
  }

  /** Fires when a renewal proved the lease was taken over (the outcome can't be recorded). */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get lost(): boolean {
    return this.controller.signal.aborted;
  }

  /** Conservative remaining validity of the lease, in milliseconds (0 once lost). */
  remainingMs(): number {
    return this.lost ? 0 : Math.max(0, this.validUntil - performance.now());
  }

  start(): void {
    if (this.timer !== undefined || this.deps.renewEveryMs <= 0) return;
    this.timer = setInterval(() => {
      void this.renew();
    }, this.deps.renewEveryMs);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async renew(): Promise<void> {
    if (this.renewing || this.lost) return;
    this.renewing = true;
    const sentAt = performance.now();
    try {
      const ok = await this.deps.deliveries.renewLease(
        this.deps.deliveryId,
        this.deps.leaseToken,
        this.deps.version,
        this.deps.leaseMs,
      );
      if (ok) {
        this.validUntil = Math.max(this.validUntil, sentAt + this.deps.leaseMs);
      } else {
        // Taken over (e.g. moved to unknown): stop before submitting if still possible; the
        // result can no longer be recorded anyway.
        this.deps.logger.warn({ deliveryId: this.deps.deliveryId }, 'lease lost while sending');
        this.controller.abort(new Error('lease lost'));
        this.stop();
      }
    } catch (error) {
      this.deps.logger.warn(
        {
          deliveryId: this.deps.deliveryId,
          err: error instanceof Error ? error.message : String(error),
        },
        'lease renewal failed',
      );
    } finally {
      this.renewing = false;
    }
  }
}
