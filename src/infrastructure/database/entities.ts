import { defineEntity, p } from '@mikro-orm/core';
import type { ApiScope } from '../../contracts/statuses.js';
import type { ProviderInstanceLimits } from '../../application/ports/lookup-repositories.js';
import type { RoutingSnapshot } from '../../application/ports/repositories.js';

/**
 * MikroORM entity schemas (no decorators). They mirror the hand-written SQL in
 * migrations/ column by column. Relations are modelled as scalar bigint columns: the
 * composite (tenant_id, x_id) foreign keys live only in the SQL migration because
 * MikroORM metadata cannot express a foreign key to a non-primary unique key.
 * See tests/integration/database/schema.test.ts for the metadata/schema check.
 */

const ts = () => p.datetime().columnType('timestamptz(3)');
const id = () => p.bigint('number');
// `generated always as identity` in SQL: ids are assigned by PostgreSQL only.
const pk = () => p.bigint('number').primary().autoincrement().generated('identity');
const CHANNEL_CHECK = `channel in ('email', 'sms', 'push', 'messaging')`;
const PLATFORM_CHECK = `(channel in ('email', 'sms') and platform is null) or (channel = 'push' and platform in ('fcm', 'apns')) or (channel = 'messaging' and platform in ('whatsapp', 'telegram'))`;
const LEASE_CHECK = '(lease_token is null) = (lease_expires_at is null)';
const jsonb = <T>() => p.json<T>().columnType('jsonb');

export const TenantSchema = defineEntity({
  name: 'Tenant',
  tableName: 'tenants',
  uniques: [{ name: 'tenants_slug_unique', properties: ['slug'] }],
  checks: [{ name: 'tenants_status_check', expression: `status in ('active', 'suspended')` }],
  properties: {
    id: pk(),
    slug: p.text(),
    name: p.text(),
    status: p.text().default('active'),
    quotas: jsonb<Record<string, unknown>>().defaultRaw(`'{}'::jsonb`),
    createdAt: ts().defaultRaw('now()'),
    updatedAt: ts().defaultRaw('now()'),
  },
});

export const ApiKeySchema = defineEntity({
  name: 'ApiKey',
  tableName: 'api_keys',
  uniques: [
    { name: 'api_keys_key_prefix_unique', properties: ['keyPrefix'] },
    { name: 'api_keys_tenant_id_name_unique', properties: ['tenantId', 'name'] },
  ],
  checks: [
    {
      name: 'api_keys_scopes_check',
      expression: `cardinality(scopes) > 0 and scopes <@ array['notifications:write', 'notifications:read', 'notifications:retry']::text[]`,
    },
  ],
  properties: {
    id: pk(),
    tenantId: id(),
    name: p.text(),
    keyPrefix: p.text(),
    keyHash: p.text(),
    scopes: p.array<ApiScope>().columnType('text[]'),
    createdAt: ts().defaultRaw('now()'),
    expiresAt: ts().nullable(),
    revokedAt: ts().nullable(),
    lastUsedAt: ts().nullable(),
  },
});

export const ProviderInstanceSchema = defineEntity({
  name: 'ProviderInstance',
  tableName: 'provider_instances',
  uniques: [
    { name: 'provider_instances_tenant_id_id_unique', properties: ['tenantId', 'id'] },
    { name: 'provider_instances_tenant_id_name_unique', properties: ['tenantId', 'name'] },
  ],
  checks: [
    { name: 'provider_instances_channel_check', expression: CHANNEL_CHECK },
    { name: 'provider_instances_platform_check', expression: PLATFORM_CHECK },
    { name: 'provider_instances_revision_check', expression: 'revision > 0' },
  ],
  properties: {
    id: pk(),
    tenantId: id(),
    name: p.text(),
    providerType: p.text(),
    channel: p.text(),
    platform: p.text().nullable(),
    config: jsonb<Record<string, unknown>>().defaultRaw(`'{}'::jsonb`),
    secretRef: p.text().nullable(),
    enabled: p.boolean().default(true),
    revision: p.integer().default(1),
    limits: jsonb<ProviderInstanceLimits>().defaultRaw(`'{}'::jsonb`),
    createdAt: ts().defaultRaw('now()'),
    updatedAt: ts().defaultRaw('now()'),
  },
});

export const RoutingPolicySchema = defineEntity({
  name: 'RoutingPolicy',
  tableName: 'routing_policies',
  uniques: [
    { name: 'routing_policies_tenant_id_id_unique', properties: ['tenantId', 'id'] },
    {
      name: 'routing_policies_version_unique',
      expression:
        'alter table routing_policies add constraint routing_policies_version_unique unique nulls not distinct (tenant_id, routing_key, channel, platform, version)',
    },
  ],
  checks: [
    { name: 'routing_policies_channel_check', expression: CHANNEL_CHECK },
    { name: 'routing_policies_platform_check', expression: PLATFORM_CHECK },
    { name: 'routing_policies_version_check', expression: 'version > 0' },
    { name: 'routing_policies_max_attempts_check', expression: 'max_attempts between 1 and 100' },
    { name: 'routing_policies_ttl_seconds_check', expression: 'ttl_seconds > 0' },
  ],
  properties: {
    id: pk(),
    tenantId: id(),
    routingKey: p.text(),
    channel: p.text(),
    platform: p.text().nullable(),
    version: p.integer(),
    enabled: p.boolean().default(true),
    maxAttempts: p.integer().default(5),
    ttlSeconds: p.integer().default(86400),
    fallbackEnabled: p.boolean().default(true),
    createdAt: ts().defaultRaw('now()'),
  },
});

export const RoutingPolicyProviderSchema = defineEntity({
  name: 'RoutingPolicyProvider',
  tableName: 'routing_policy_providers',
  uniques: [
    {
      name: 'routing_policy_providers_instance_unique',
      properties: ['routingPolicyId', 'providerInstanceId'],
    },
  ],
  checks: [{ name: 'routing_policy_providers_position_check', expression: 'position >= 0' }],
  properties: {
    routingPolicyId: id().primary(),
    position: p.integer().primary(),
    tenantId: id(),
    providerInstanceId: id(),
  },
});

export const NotificationSchema = defineEntity({
  name: 'Notification',
  tableName: 'notifications',
  uniques: [
    { name: 'notifications_tenant_id_id_unique', properties: ['tenantId', 'id'] },
    { name: 'notifications_idempotency_unique', properties: ['tenantId', 'idempotencyKey'] },
  ],
  indexes: [
    {
      name: 'notifications_tenant_id_created_at_index',
      properties: ['tenantId', 'createdAt', 'id'],
    },
  ],
  checks: [{ name: 'notifications_channel_check', expression: CHANNEL_CHECK }],
  properties: {
    id: pk(),
    tenantId: id(),
    idempotencyKey: p.text(),
    requestHash: p.text(),
    channel: p.text(),
    routingKey: p.text(),
    routingPolicyId: id(),
    payload: jsonb<Record<string, unknown>>(),
    metadata: jsonb<Record<string, unknown>>().defaultRaw(`'{}'::jsonb`),
    routingSnapshot: jsonb<RoutingSnapshot>(),
    createdAt: ts().defaultRaw('now()'),
  },
});

export const DeliverySchema = defineEntity({
  name: 'Delivery',
  tableName: 'deliveries',
  uniques: [{ name: 'deliveries_tenant_id_id_unique', properties: ['tenantId', 'id'] }],
  indexes: [
    { name: 'deliveries_ready_index', properties: ['submissionStatus', 'nextAttemptAt'] },
    { name: 'deliveries_notification_id_index', properties: ['tenantId', 'notificationId'] },
    {
      name: 'deliveries_sending_lease_index',
      expression: `create index deliveries_sending_lease_index on deliveries (lease_expires_at) where submission_status = 'sending'`,
    },
  ],
  checks: [
    { name: 'deliveries_channel_check', expression: CHANNEL_CHECK },
    {
      name: 'deliveries_submission_status_check',
      expression: `submission_status in ('pending', 'sending', 'retry_wait', 'accepted', 'failed', 'unknown', 'suppressed', 'expired')`,
    },
    {
      name: 'deliveries_receipt_status_check',
      expression: `receipt_status in ('unavailable', 'pending', 'delivered', 'undeliverable')`,
    },
    { name: 'deliveries_generation_check', expression: 'generation > 0' },
    { name: 'deliveries_attempts_check', expression: 'attempts_used >= 0 and max_attempts > 0' },
    { name: 'deliveries_version_check', expression: 'version >= 0' },
    { name: 'deliveries_lease_check', expression: LEASE_CHECK },
  ],
  properties: {
    id: pk(),
    tenantId: id(),
    notificationId: id(),
    channel: p.text(),
    recipient: p.text(),
    submissionStatus: p.text().default('pending'),
    receiptStatus: p.text().default('unavailable'),
    generation: p.integer().default(1),
    attemptsUsed: p.integer().default(0),
    maxAttempts: p.integer(),
    nextAttemptAt: ts().nullable(),
    expiresAt: ts(),
    leaseToken: p.uuid().nullable(),
    leaseExpiresAt: ts().nullable(),
    version: p.integer().default(0),
    lastErrorCode: p.text().nullable(),
    lastErrorMessage: p.text().nullable(),
    terminalReason: p.text().nullable(),
    createdAt: ts().defaultRaw('now()'),
    updatedAt: ts().defaultRaw('now()'),
  },
});

export const DeliveryAttemptSchema = defineEntity({
  name: 'DeliveryAttempt',
  tableName: 'delivery_attempts',
  uniques: [
    { name: 'delivery_attempts_number_unique', properties: ['deliveryId', 'attemptNumber'] },
  ],
  indexes: [
    {
      name: 'delivery_attempts_external_reference_index',
      expression:
        'create index delivery_attempts_external_reference_index on delivery_attempts (provider_instance_id, external_reference) where external_reference is not null',
    },
  ],
  checks: [
    { name: 'delivery_attempts_attempt_number_check', expression: 'attempt_number > 0' },
    {
      name: 'delivery_attempts_outcome_check',
      expression: `outcome in ('started', 'accepted', 'rejected', 'unknown')`,
    },
    {
      name: 'delivery_attempts_error_kind_check',
      expression: `error_kind is null or error_kind in ('retryable', 'permanent', 'configuration')`,
    },
  ],
  properties: {
    id: pk(),
    tenantId: id(),
    deliveryId: id(),
    attemptNumber: p.integer(),
    generation: p.integer(),
    providerInstanceId: id(),
    providerInstanceRevision: p.integer(),
    providerIdempotencyKey: p.text(),
    outcome: p.text().default('started'),
    startedAt: ts().defaultRaw('now()'),
    finishedAt: ts().nullable(),
    errorKind: p.text().nullable(),
    errorCode: p.text().nullable(),
    errorMessage: p.text().nullable(),
    externalReference: p.text().nullable(),
  },
});

export const OutboxEventSchema = defineEntity({
  name: 'OutboxEvent',
  tableName: 'outbox_events',
  uniques: [
    { name: 'outbox_events_intent_unique', properties: ['deliveryId', 'generation', 'eventType'] },
  ],
  indexes: [
    {
      name: 'outbox_events_available_index',
      expression: `create index outbox_events_available_index on outbox_events (available_at) where status <> 'published'`,
    },
    {
      name: 'outbox_events_published_index',
      expression: `create index outbox_events_published_index on outbox_events (published_at) where status = 'published'`,
    },
  ],
  checks: [
    { name: 'outbox_events_event_type_check', expression: `event_type in ('dispatch_delivery')` },
    {
      name: 'outbox_events_status_check',
      expression: `status in ('pending', 'publishing', 'published')`,
    },
    { name: 'outbox_events_dispatch_count_check', expression: 'dispatch_count >= 0' },
    { name: 'outbox_events_lease_check', expression: LEASE_CHECK },
  ],
  properties: {
    id: pk(),
    tenantId: id(),
    deliveryId: id(),
    generation: p.integer(),
    eventType: p.text(),
    status: p.text().default('pending'),
    availableAt: ts().defaultRaw('now()'),
    leaseToken: p.uuid().nullable(),
    leaseExpiresAt: ts().nullable(),
    dispatchCount: p.integer().default(0),
    publishedAt: ts().nullable(),
    lastError: p.text().nullable(),
    createdAt: ts().defaultRaw('now()'),
    updatedAt: ts().defaultRaw('now()'),
  },
});

export const ProviderEventSchema = defineEntity({
  name: 'ProviderEvent',
  tableName: 'provider_events',
  uniques: [
    { name: 'provider_events_tenant_id_id_unique', properties: ['tenantId', 'id'] },
    {
      name: 'provider_events_external_event_unique',
      properties: ['providerInstanceId', 'externalEventId'],
    },
  ],
  indexes: [
    {
      name: 'provider_events_message_index',
      expression:
        'create index provider_events_message_index on provider_events (provider_instance_id, external_message_id) where external_message_id is not null',
    },
    {
      name: 'provider_events_unprocessed_index',
      expression:
        'create index provider_events_unprocessed_index on provider_events (received_at) where processed_at is null',
    },
  ],
  checks: [
    {
      name: 'provider_events_event_type_check',
      expression: `event_type in ('accepted', 'delivered', 'delivery_delayed', 'bounced_hard', 'bounced_soft', 'complained', 'failed', 'opened', 'clicked', 'other')`,
    },
  ],
  properties: {
    id: pk(),
    tenantId: id(),
    providerInstanceId: id(),
    externalEventId: p.text(),
    externalMessageId: p.text().nullable(),
    eventType: p.text(),
    occurredAt: ts(),
    receivedAt: ts().defaultRaw('now()'),
    deliveryId: id().nullable(),
    processedAt: ts().nullable(),
    payload: jsonb<Record<string, unknown>>().defaultRaw(`'{}'::jsonb`),
  },
});

export const SuppressionSchema = defineEntity({
  name: 'Suppression',
  tableName: 'suppressions',
  uniques: [
    {
      name: 'suppressions_recipient_unique',
      properties: ['tenantId', 'channel', 'recipientKey'],
    },
  ],
  checks: [
    { name: 'suppressions_channel_check', expression: CHANNEL_CHECK },
    {
      name: 'suppressions_reason_check',
      expression: `reason in ('hard_bounce', 'complaint', 'manual', 'unsubscribe')`,
    },
    { name: 'suppressions_source_check', expression: `source in ('provider_event', 'admin')` },
  ],
  properties: {
    id: pk(),
    tenantId: id(),
    channel: p.text(),
    recipientKey: p.text(),
    reason: p.text(),
    source: p.text(),
    providerEventId: id().nullable(),
    createdAt: ts().defaultRaw('now()'),
  },
});

export const AuditEventSchema = defineEntity({
  name: 'AuditEvent',
  tableName: 'audit_events',
  indexes: [
    { name: 'audit_events_tenant_id_occurred_at_index', properties: ['tenantId', 'occurredAt'] },
  ],
  properties: {
    id: pk(),
    tenantId: id().nullable(),
    actor: p.text(),
    operation: p.text(),
    resourceType: p.text(),
    resourceId: p.text().nullable(),
    details: jsonb<Record<string, unknown>>().defaultRaw(`'{}'::jsonb`),
    occurredAt: ts().defaultRaw('now()'),
  },
});

export const ENTITIES = [
  TenantSchema,
  ApiKeySchema,
  ProviderInstanceSchema,
  RoutingPolicySchema,
  RoutingPolicyProviderSchema,
  NotificationSchema,
  DeliverySchema,
  DeliveryAttemptSchema,
  OutboxEventSchema,
  ProviderEventSchema,
  SuppressionSchema,
  AuditEventSchema,
] as const;
