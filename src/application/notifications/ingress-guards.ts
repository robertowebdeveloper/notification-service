import type { Logger } from 'pino';
import { ApplicationError } from './errors.js';
import type { RateLimitDecision, RateLimiter } from './ports.js';

/**
 * Fixed-window limit on a shared Valkey counter: per tenant for the API (`INGRESS_RATE_*`,
 * `READ_RATE_*`), per provider instance for verified webhooks (`WEBHOOK_RATE_*`), per client IP
 * or instance for failures (`AUTH_FAILURE_RATE_*`, `WEBHOOK_INVALID_RATE_*`).
 */
export interface IngressRateLimit {
  limit: number;
  windowMs: number;
}

/**
 * Rejects with 429 when the tenant exceeded its window. When the limiter is unavailable the
 * request is allowed (the PostgreSQL outbox protects the pipeline) and the failure is logged.
 */
export class IngressLimiter {
  constructor(
    private readonly limiter: RateLimiter | null,
    private readonly settings: IngressRateLimit,
    private readonly logger: Pick<Logger, 'warn'>,
    private readonly keyPrefix = 'ingress:',
  ) {}

  /** `subject` is the limited principal: a tenant id (API) or a provider instance id (webhooks). */
  async check(subject: string): Promise<void> {
    if (this.limiter === null) return;
    let decision;
    try {
      decision = await this.limiter.consume(
        this.keyPrefix + subject,
        this.settings.limit,
        this.settings.windowMs,
      );
    } catch (err) {
      this.logger.warn({ err, principal: subject }, 'rate limiter unavailable, allowing request');
      return;
    }
    if (!decision.allowed) throw rateLimited(decision.retryAfterMs);
  }
}

export function rateLimited(retryAfterMs: number): ApplicationError {
  return new ApplicationError(
    'rate_limited',
    'Too many requests, retry later',
    undefined,
    Math.max(1, Math.ceil(retryAfterMs / 1000)),
  );
}

/**
 * Budget charged only by failures (failed authentication per client IP, invalid webhooks per
 * instance). `assertNotExhausted` runs before any expensive work (database lookup, signature
 * verification) and does not count; `recordFailure` counts after a failure. Successful requests
 * never consume it. Fails open (with a warning) when the limiter is unavailable.
 */
export class FailureBudget {
  constructor(
    private readonly limiter: RateLimiter | null,
    private readonly settings: IngressRateLimit,
    private readonly logger: Pick<Logger, 'warn'>,
    private readonly keyPrefix: string,
  ) {}

  /** Throws 429 when `subject` already used its failure budget in the current window. */
  async assertNotExhausted(subject: string): Promise<void> {
    if (this.limiter?.peek === undefined) return;
    let decision;
    try {
      decision = await this.limiter.peek(this.keyPrefix + subject, this.settings.limit);
    } catch (err) {
      this.logger.warn(
        { err, scope: this.keyPrefix },
        'rate limiter unavailable, allowing request',
      );
      return;
    }
    if (!decision.allowed) throw rateLimited(decision.retryAfterMs);
  }

  /** Counts one failure; `allowed` is false once the budget is exceeded. Never throws. */
  async recordFailure(subject: string): Promise<RateLimitDecision> {
    if (this.limiter === null) return { allowed: true, retryAfterMs: 0 };
    try {
      return await this.limiter.consume(
        this.keyPrefix + subject,
        this.settings.limit,
        this.settings.windowMs,
      );
    } catch (err) {
      this.logger.warn(
        { err, scope: this.keyPrefix },
        'rate limiter unavailable, failure not counted',
      );
      return { allowed: true, retryAfterMs: 0 };
    }
  }
}

/** Cached view of the pending outbox size, shared by ingestion (503) and readiness. */
export class BacklogGuard {
  private cached: { value: number; at: number } | null = null;

  constructor(
    private readonly countPending: () => Promise<number>,
    readonly limit: number,
    private readonly cacheMs = 1_000,
    private readonly now: () => number = Date.now,
  ) {}

  async pending(): Promise<number> {
    const now = this.now();
    if (this.cached !== null && now - this.cached.at < this.cacheMs) return this.cached.value;
    const value = await this.countPending();
    this.cached = { value, at: now };
    return value;
  }

  async isOverLimit(): Promise<boolean> {
    return (await this.pending()) > this.limit;
  }

  async assertAccepting(): Promise<void> {
    if (await this.isOverLimit()) {
      throw new ApplicationError(
        'dependency_unavailable',
        'Delivery backlog is above the configured threshold, retry later',
        undefined,
        5,
      );
    }
  }
}
