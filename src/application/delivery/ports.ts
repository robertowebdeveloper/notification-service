import type { Channel } from '../../contracts/channels.js';
import type { DeliveryJobData } from '../../contracts/jobs.js';
import type { ProviderAdapter, SecretValues } from '../../contracts/provider-port.js';
import type { CircuitBreakerSettings, SendRateLimit } from '../ports/lookup-repositories.js';

/**
 * Ports owned by the delivery pipeline (providers, shared limits, queue, logging). Persistence
 * ports live in `application/ports` (see `delivery-control.ts`).
 */

// ---------------------------------------------------------------- Providers

/** Structural subset of the provider registry used by the pipeline. */
export interface ProviderCatalog {
  forChannel<C extends Channel>(providerType: string, channel: C): ProviderAdapter<C> | undefined;
  requiredSecretsFor(providerType: string, validatedConfig: unknown): readonly string[];
}

export interface SecretSource {
  resolve(secretRef: string, keys: readonly string[]): Promise<SecretValues>;
}

// ---------------------------------------------------------------- Shared limits (Valkey)

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterMs: number };

/**
 * Token bucket per provider instance. `limit` is the instance override; without it the
 * implementation applies its configured default. Throws when the limiter backend is unavailable.
 */
export interface ProviderRateLimiter {
  tryAcquire(providerInstanceId: number, limit?: SendRateLimit): Promise<RateLimitDecision>;
}

/**
 * `probeToken` identifies the single half-open recovery probe: only its holder can close the
 * breaker with a success, and it must give the probe back when it does not send after all.
 */
export type BreakerPermit =
  | { allowed: true; probe: false }
  | { allowed: true; probe: true; probeToken: string }
  | { allowed: false; retryAfterMs: number };

/** Shared circuit breaker per provider instance. Throws when the backend is unavailable. */
export interface ProviderCircuitBreaker {
  acquire(providerInstanceId: number): Promise<BreakerPermit>;
  /**
   * The provider answered (accepted, or a definite non-retryable rejection). In half-open state
   * only the probe holder (`probeToken`) closes the breaker; other successes are ignored.
   */
  recordSuccess(providerInstanceId: number, probeToken?: string): Promise<void>;
  /** `settings` are the instance overrides; missing fields use the configured defaults. */
  recordFailure(providerInstanceId: number, settings?: CircuitBreakerSettings): Promise<void>;
  /** Opens the breaker for `durationMs` (operational quarantine after a configuration error). */
  forceOpen(providerInstanceId: number, durationMs: number): Promise<void>;
  /**
   * Gives back a half-open probe that will not be used (delivery deferred, claim fenced before
   * the send), so the next caller can probe immediately instead of waiting for the probe TTL.
   */
  releaseProbe(providerInstanceId: number, probeToken: string): Promise<void>;
}

// ---------------------------------------------------------------- Queue

export class QueuePublishError extends Error {
  constructor(
    readonly code: 'queue_unavailable' | 'publish_timeout' | 'publish_failed' | 'no_queue',
    message: string,
  ) {
    super(message);
    this.name = 'QueuePublishError';
  }
}

export interface DeliveryJobPublisher {
  /** Resolves only after the queue confirmed the job; rejects (bounded in time) otherwise. */
  publish(channel: Channel, jobId: string, data: DeliveryJobData): Promise<void>;
}

/** Read-only view of queued jobs, used to tell a slow queue from a lost job. */
export interface DeliveryJobInspector {
  /**
   * True when the job is still waiting, delayed or active in the queue. Throws (bounded in
   * time) when the queue backend cannot answer.
   */
  isJobPending(channel: Channel, jobId: string): Promise<boolean>;
}

// ---------------------------------------------------------------- Observability

type LogFn = (obj: Record<string, unknown>, msg: string) => void;

/** Structural subset of a pino logger. */
export interface DeliveryLogger {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
}

export const silentLogger: DeliveryLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
