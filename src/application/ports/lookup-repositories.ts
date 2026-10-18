import type { Channel } from '../../contracts/channels.js';
import type { NormalizedEventType } from '../../contracts/provider-port.js';
import type { ApiScope, ReceiptStatus } from '../../contracts/statuses.js';

/**
 * Additional repository ports needed by phase 2 (API auth, routing, webhooks, suppressions,
 * audit and config:apply). Every tenant-scoped method takes tenantId explicitly.
 */

/** Thrown by NotificationRepository.list for malformed or tampered cursors (map to HTTP 400). */
export class InvalidCursorError extends Error {
  constructor() {
    super('Invalid pagination cursor');
    this.name = 'InvalidCursorError';
  }
}

// ---------------------------------------------------------------- API keys

export interface ApiKeyRecord {
  id: number;
  tenantId: number;
  /** Hash stored at creation; compare with a timing-safe function. */
  keyHash: string;
  scopes: ApiScope[];
  expiresAt: Date | null;
  revokedAt: Date | null;
  tenantActive: boolean;
}

export interface ApiKeyRepository {
  /** Lookup by the non-secret key prefix; the caller verifies the hash and validity. */
  findByPrefix(keyPrefix: string): Promise<ApiKeyRecord | null>;
  touchLastUsed(apiKeyId: number, at: Date): Promise<void>;
}

// ---------------------------------------------------------------- Providers and routing

/** Token bucket of one provider instance: `burst` tokens, refilled at `perSecond`. */
export interface SendRateLimit {
  burst: number;
  perSecond: number;
}

/** Circuit breaker overrides of one provider instance; missing fields use the defaults. */
export interface CircuitBreakerSettings {
  /** Failures within `failureWindowMs` that open the breaker. */
  failureThreshold?: number;
  failureWindowMs?: number;
  /** Open time before a single recovery probe is allowed. */
  openMs?: number;
}

/** Operator overrides of the worker defaults (`PROVIDER_RATE_LIMIT_*`, `CIRCUIT_BREAKER_*`). */
export interface ProviderInstanceLimits {
  sendRateLimit?: SendRateLimit;
  circuitBreaker?: CircuitBreakerSettings;
}

export interface ProviderInstanceRecord {
  id: number;
  tenantId: number;
  name: string;
  providerType: string;
  channel: Channel;
  platform: string | null;
  config: Record<string, unknown>;
  secretRef: string | null;
  enabled: boolean;
  revision: number;
  /** Per-instance send limits; empty object when the env defaults apply. */
  limits: ProviderInstanceLimits;
}

export interface RoutingPolicyRecord {
  id: number;
  tenantId: number;
  routingKey: string;
  channel: Channel;
  platform: string | null;
  version: number;
  enabled: boolean;
  maxAttempts: number;
  ttlSeconds: number;
  fallbackEnabled: boolean;
  /** Ordered by position; includes disabled instances so callers can apply kill switches. */
  providers: ProviderInstanceRecord[];
}

export interface ProviderConfigRepository {
  findProviderInstance(tenantId: number, id: number): Promise<ProviderInstanceRecord | null>;
  /** Webhook entry point: tenant is derived from the instance, never from the payload. */
  findProviderInstanceForWebhook(
    providerType: string,
    instanceId: number,
  ): Promise<ProviderInstanceRecord | null>;
  /** Latest version of the policy for (tenant, routingKey, channel, platform). */
  resolveRoutingPolicy(
    tenantId: number,
    routingKey: string,
    channel: Channel,
    platform: string | null,
  ): Promise<RoutingPolicyRecord | null>;
}

// ---------------------------------------------------------------- Provider events (webhooks)

export interface ProviderEventInput {
  tenantId: number;
  providerInstanceId: number;
  externalEventId: string;
  externalMessageId: string | null;
  type: NormalizedEventType;
  occurredAt: Date;
  receivedAt: Date;
  /** Minimized payload: no bodies or secrets. */
  payload: Record<string, unknown>;
}

export interface StoredProviderEvent {
  id: number;
  tenantId: number;
  providerInstanceId: number;
  externalEventId: string;
  externalMessageId: string | null;
  type: NormalizedEventType;
  occurredAt: Date;
  receivedAt: Date;
  /** Correlated delivery, null while the external reference is not yet known. */
  deliveryId: number | null;
  processedAt: Date | null;
}

export type RecordProviderEventResult =
  | { kind: 'inserted'; event: StoredProviderEvent }
  | { kind: 'duplicate'; event: StoredProviderEvent };

export interface ProviderEventRepository {
  /**
   * Durable insert deduplicated on (provider_instance_id, external_event_id); correlates the
   * delivery through delivery_attempts.external_reference when already known.
   */
  record(input: ProviderEventInput): Promise<RecordProviderEventResult>;
  /** Unprocessed events already correlated to a delivery, oldest first. */
  findUnprocessedCorrelated(limit: number): Promise<StoredProviderEvent[]>;
  /**
   * Unprocessed, still uncorrelated events received at or before `receivedBefore` (orphan
   * candidates), oldest first. Kept separate so a backlog of uncorrelated events can never
   * starve correlated ones.
   */
  findUncorrelatedReceivedBefore(
    receivedBefore: Date,
    limit: number,
  ): Promise<StoredProviderEvent[]>;
  /** Retries correlation of uncorrelated events; returns how many got a delivery. */
  correlatePending(limit: number): Promise<number>;
  markProcessed(tenantId: number, eventId: number, at: Date): Promise<boolean>;
}

export interface DeliveryReceiptRepository {
  /**
   * Compare-and-set of receipt_status: applies `to` only if the current value is in `from`
   * (the deterministic reducer decides precedence). Returns false when nothing changed.
   */
  updateReceiptStatus(
    tenantId: number,
    deliveryId: number,
    from: readonly ReceiptStatus[],
    to: ReceiptStatus,
  ): Promise<boolean>;
}

// ---------------------------------------------------------------- Suppressions

export type SuppressionReason = 'hard_bounce' | 'complaint' | 'manual' | 'unsubscribe';
export type SuppressionSource = 'provider_event' | 'admin';

export interface SuppressionInput {
  tenantId: number;
  channel: Channel;
  /** Channel-specific normalized recipient (normalization belongs to the domain). */
  recipientKey: string;
  reason: SuppressionReason;
  source: SuppressionSource;
  providerEventId: number | null;
}

export interface SuppressionRepository {
  isSuppressed(tenantId: number, channel: Channel, recipientKey: string): Promise<boolean>;
  /** Idempotent: an existing suppression is kept unchanged. Returns true when created. */
  add(input: SuppressionInput): Promise<boolean>;
}

// ---------------------------------------------------------------- Audit

export interface AuditEventInput {
  tenantId: number | null;
  actor: string;
  operation: string;
  resourceType: string;
  resourceId: string | null;
  /** No message contents or secrets. */
  details: Record<string, unknown>;
}

export interface AuditRepository {
  record(event: AuditEventInput): Promise<void>;
}

// ---------------------------------------------------------------- Admin configuration (config:apply)

export interface TenantConfig {
  slug: string;
  name: string;
  status: 'active' | 'suspended';
  quotas: Record<string, unknown>;
}

export interface ApiKeyConfig {
  name: string;
  keyPrefix: string;
  keyHash: string;
  scopes: ApiScope[];
  expiresAt: Date | null;
  revoked: boolean;
}

export interface ProviderInstanceConfig {
  name: string;
  providerType: string;
  channel: Channel;
  platform: string | null;
  config: Record<string, unknown>;
  secretRef: string | null;
  enabled: boolean;
  limits: ProviderInstanceLimits;
}

export interface RoutingPolicyConfig {
  routingKey: string;
  channel: Channel;
  platform: string | null;
  enabled: boolean;
  maxAttempts: number;
  ttlSeconds: number;
  fallbackEnabled: boolean;
  /** Provider instance names, in priority order. */
  providerNames: string[];
}

export interface UpsertOutcome {
  id: number;
  changed: boolean;
}

export interface AdminConfigRepository {
  /** Each method runs in its own transaction and writes an audit event when something changed. */
  upsertTenant(actor: string, tenant: TenantConfig): Promise<UpsertOutcome>;
  upsertApiKey(actor: string, tenantId: number, key: ApiKeyConfig): Promise<UpsertOutcome>;
  /** Bumps revision when any field changes. */
  upsertProviderInstance(
    actor: string,
    tenantId: number,
    instance: ProviderInstanceConfig,
  ): Promise<UpsertOutcome>;
  /** Inserts a new version only when the effective policy differs from the latest one. */
  publishRoutingPolicy(
    actor: string,
    tenantId: number,
    policy: RoutingPolicyConfig,
  ): Promise<UpsertOutcome & { version: number }>;
}
