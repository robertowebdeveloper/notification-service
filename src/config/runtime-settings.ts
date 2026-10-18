import type { DispatchOutboxOptions } from '../application/delivery/dispatch-outbox.js';
import type { ProcessDeliveryOptions } from '../application/delivery/process-delivery.js';
import type { ProviderEventOptions } from '../application/delivery/process-provider-events.js';
import type { ReconcileOptions } from '../application/delivery/reconcile.js';
import type { IngressRateLimit } from '../application/notifications/ingress-guards.js';
import type {
  CircuitBreakerSettings,
  SendRateLimit,
} from '../application/ports/lookup-repositories.js';
import type { RetryPolicy } from '../domain/retry-policy.js';
import {
  parseAllowedHosts,
  type ProviderDeploymentPolicy,
} from '../infrastructure/providers/deployment-policy.js';
import type { AppConfig } from './env.js';

/**
 * Maps the validated environment to the option objects of the use cases and adapters, so the
 * composition roots never hard-code operational values. Options not listed here keep the
 * defaults of their use case.
 */

export function retryPolicyOf(config: AppConfig): RetryPolicy {
  return {
    baseDelayMs: config.RETRY_BACKOFF_BASE_MS,
    maxDelayMs: config.RETRY_BACKOFF_MAX_MS,
    jitterRatio: config.RETRY_JITTER_RATIO,
  };
}

export function ingressRateLimitOf(config: AppConfig): IngressRateLimit {
  return { limit: config.INGRESS_RATE_LIMIT, windowMs: config.INGRESS_RATE_WINDOW_MS };
}

export function webhookRateLimitOf(config: AppConfig): IngressRateLimit {
  return { limit: config.WEBHOOK_RATE_LIMIT, windowMs: config.WEBHOOK_RATE_WINDOW_MS };
}

/** Failed verifications per provider instance (`WEBHOOK_INVALID_RATE_*`). */
export function webhookInvalidRateLimitOf(config: AppConfig): IngressRateLimit {
  return {
    limit: config.WEBHOOK_INVALID_RATE_LIMIT,
    windowMs: config.WEBHOOK_INVALID_RATE_WINDOW_MS,
  };
}

/** Failed authentications per client IP (`AUTH_FAILURE_RATE_*`). */
export function authFailureRateLimitOf(config: AppConfig): IngressRateLimit {
  return { limit: config.AUTH_FAILURE_RATE_LIMIT, windowMs: config.AUTH_FAILURE_RATE_WINDOW_MS };
}

/** Read requests per tenant (`READ_RATE_*`). */
export function readRateLimitOf(config: AppConfig): IngressRateLimit {
  return { limit: config.READ_RATE_LIMIT, windowMs: config.READ_RATE_WINDOW_MS };
}

/** Restrictions enforced on every provider instance configuration (config:apply and runtime). */
export function providerDeploymentPolicyOf(config: AppConfig): ProviderDeploymentPolicy {
  return {
    environment: config.APP_ENV,
    allowedHosts: parseAllowedHosts(config.PROVIDER_ALLOWED_HOSTS),
  };
}

export interface HttpServerSettings {
  requestTimeoutMs: number;
  handlerTimeoutMs: number;
  trustProxy: boolean | number | string;
}

export function httpServerSettingsOf(config: AppConfig): HttpServerSettings {
  const raw = config.HTTP_TRUST_PROXY;
  let trustProxy: boolean | number | string = false;
  if (raw === 'true') trustProxy = true;
  else if (raw !== undefined && raw !== 'false') {
    trustProxy = /^[0-9]+$/.test(raw) ? Number(raw) : raw.replace(/ /g, '');
  }
  return {
    requestTimeoutMs: config.HTTP_REQUEST_TIMEOUT_MS,
    handlerTimeoutMs: config.HTTP_HANDLER_TIMEOUT_MS,
    trustProxy,
  };
}

export function processDeliveryOptionsOf(config: AppConfig): Partial<ProcessDeliveryOptions> {
  return {
    leaseMs: config.DELIVERY_LEASE_MS,
    sendTimeoutMs: config.WORKER_SEND_TIMEOUT_MS,
    retryPolicy: retryPolicyOf(config),
  };
}

export function defaultSendRateLimitOf(config: AppConfig): SendRateLimit {
  return {
    burst: config.PROVIDER_RATE_LIMIT_BURST,
    perSecond: config.PROVIDER_RATE_LIMIT_PER_SECOND,
  };
}

export function defaultCircuitBreakerOf(config: AppConfig): Required<CircuitBreakerSettings> {
  return {
    failureThreshold: config.CIRCUIT_BREAKER_FAILURE_THRESHOLD,
    failureWindowMs: config.CIRCUIT_BREAKER_FAILURE_WINDOW_MS,
    openMs: config.CIRCUIT_BREAKER_OPEN_MS,
  };
}

/**
 * Lease of the single half-open probe: it must outlast the probe's provider call, otherwise a
 * second caller could probe a recovering provider while the first call is still running.
 */
export function circuitBreakerProbeTtlMsOf(config: AppConfig): number {
  return Math.max(60_000, config.WORKER_SEND_TIMEOUT_MS * 2);
}

export function dispatchOutboxOptionsOf(config: AppConfig): Partial<DispatchOutboxOptions> {
  return { batchSize: config.DISPATCHER_BATCH_SIZE, leaseMs: config.OUTBOX_LEASE_MS };
}

export function reconcileOptionsOf(config: AppConfig): Partial<ReconcileOptions> {
  return {
    batchSize: config.RECONCILE_BATCH_SIZE,
    lostPublicationAfterMs: config.LOST_PUBLICATION_AFTER_MS,
    unknownCheckIntervalMs: config.UNKNOWN_CHECK_INTERVAL_MS,
    replayDelayMs: config.UNKNOWN_REPLAY_DELAY_MS,
    retryPolicy: retryPolicyOf(config),
  };
}

export function providerEventOptionsOf(config: AppConfig): Partial<ProviderEventOptions> {
  return {
    batchSize: config.PROVIDER_EVENT_BATCH_SIZE,
    orphanAfterMs: config.PROVIDER_EVENT_ORPHAN_AFTER_MS,
  };
}

export interface DispatcherLoopSettings {
  pollIntervalMs: number;
  reconcileIntervalMs: number;
  maxBatchesPerCycle: number;
  batchSize: number;
  publishTimeoutMs: number;
}

export function dispatcherLoopOf(config: AppConfig): DispatcherLoopSettings {
  return {
    pollIntervalMs: config.DISPATCHER_POLL_INTERVAL_MS,
    reconcileIntervalMs: config.RECONCILE_INTERVAL_MS,
    maxBatchesPerCycle: config.DISPATCHER_MAX_BATCHES_PER_CYCLE,
    batchSize: config.DISPATCHER_BATCH_SIZE,
    publishTimeoutMs: config.QUEUE_PUBLISH_TIMEOUT_MS,
  };
}
