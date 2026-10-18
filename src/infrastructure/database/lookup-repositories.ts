import type { QueryResult } from '@mikro-orm/core';
import type { Channel } from '../../contracts/channels.js';
import type { NormalizedEventType } from '../../contracts/provider-port.js';
import type { ApiScope, ReceiptStatus } from '../../contracts/statuses.js';
import type {
  ApiKeyRecord,
  ApiKeyRepository,
  AuditEventInput,
  AuditRepository,
  CircuitBreakerSettings,
  DeliveryReceiptRepository,
  ProviderConfigRepository,
  ProviderEventInput,
  ProviderEventRepository,
  ProviderInstanceLimits,
  ProviderInstanceRecord,
  RecordProviderEventResult,
  RoutingPolicyRecord,
  StoredProviderEvent,
  SuppressionInput,
  SuppressionRepository,
} from '../../application/ports/lookup-repositories.js';
import {
  bool,
  forkEm,
  isId,
  num,
  parsePgTextArray,
  str,
  strOrNull,
  toDate,
  toDateOrNull,
  toId,
  toIdOrNull,
  type Orm,
  type Row,
} from './sql-support.js';

export class PgApiKeyRepository implements ApiKeyRepository {
  constructor(private readonly orm: Orm) {}

  async findByPrefix(keyPrefix: string): Promise<ApiKeyRecord | null> {
    const found = await forkEm(this.orm).execute<Row[]>(
      `select k.id, k.tenant_id, k.key_hash, k.scopes, k.expires_at, k.revoked_at,
              t.status = 'active' as tenant_active
       from api_keys k join tenants t on t.id = k.tenant_id
       where k.key_prefix = ?`,
      [keyPrefix],
    );
    const row = found[0];
    if (!row) return null;
    return {
      id: toId(row.id),
      tenantId: toId(row.tenant_id),
      keyHash: str(row.key_hash),
      scopes: parsePgTextArray(row.scopes) as ApiScope[],
      expiresAt: toDateOrNull(row.expires_at),
      revokedAt: toDateOrNull(row.revoked_at),
      tenantActive: bool(row.tenant_active),
    };
  }

  async touchLastUsed(apiKeyId: number, at: Date): Promise<void> {
    if (!isId(apiKeyId)) return;
    await forkEm(this.orm).execute<QueryResult>(
      `update api_keys set last_used_at = ?
       where id = ? and (last_used_at is null or last_used_at < ?)`,
      [at, apiKeyId, at],
      'run',
    );
  }
}

const INSTANCE_COLUMNS = `pi.id, pi.tenant_id, pi.name, pi.provider_type, pi.channel, pi.platform,
  pi.config, pi.secret_ref, pi.enabled, pi.revision, pi.limits`;

function toInstance(row: Row): ProviderInstanceRecord {
  return {
    id: toId(row.id),
    tenantId: toId(row.tenant_id),
    name: str(row.name),
    providerType: str(row.provider_type),
    channel: str(row.channel) as Channel,
    platform: strOrNull(row.platform),
    config: row.config as Record<string, unknown>,
    secretRef: strOrNull(row.secret_ref),
    enabled: bool(row.enabled),
    revision: num(row.revision),
    limits: toLimits(row.limits),
  };
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Reads operator overrides defensively: anything malformed falls back to the env defaults. */
function toLimits(value: unknown): ProviderInstanceLimits {
  if (typeof value !== 'object' || value === null) return {};
  const raw = value as { sendRateLimit?: unknown; circuitBreaker?: unknown };
  const limits: ProviderInstanceLimits = {};
  if (typeof raw.sendRateLimit === 'object' && raw.sendRateLimit !== null) {
    const rate = raw.sendRateLimit as Record<string, unknown>;
    const burst = positive(rate.burst);
    const perSecond = positive(rate.perSecond);
    if (burst !== undefined && perSecond !== undefined) limits.sendRateLimit = { burst, perSecond };
  }
  if (typeof raw.circuitBreaker === 'object' && raw.circuitBreaker !== null) {
    const breaker = raw.circuitBreaker as Record<string, unknown>;
    const settings: CircuitBreakerSettings = {};
    const threshold = positive(breaker.failureThreshold);
    const windowMs = positive(breaker.failureWindowMs);
    const openMs = positive(breaker.openMs);
    if (threshold !== undefined) settings.failureThreshold = threshold;
    if (windowMs !== undefined) settings.failureWindowMs = windowMs;
    if (openMs !== undefined) settings.openMs = openMs;
    if (Object.keys(settings).length > 0) limits.circuitBreaker = settings;
  }
  return limits;
}

export class PgProviderConfigRepository implements ProviderConfigRepository {
  constructor(private readonly orm: Orm) {}

  async findProviderInstance(tenantId: number, id: number): Promise<ProviderInstanceRecord | null> {
    if (!isId(tenantId) || !isId(id)) return null;
    const found = await forkEm(this.orm).execute<Row[]>(
      `select ${INSTANCE_COLUMNS} from provider_instances pi where pi.tenant_id = ? and pi.id = ?`,
      [tenantId, id],
    );
    return found[0] ? toInstance(found[0]) : null;
  }

  async findProviderInstanceForWebhook(
    providerType: string,
    instanceId: number,
  ): Promise<ProviderInstanceRecord | null> {
    if (!isId(instanceId)) return null;
    const found = await forkEm(this.orm).execute<Row[]>(
      `select ${INSTANCE_COLUMNS} from provider_instances pi
       where pi.id = ? and pi.provider_type = ?`,
      [instanceId, providerType],
    );
    return found[0] ? toInstance(found[0]) : null;
  }

  async resolveRoutingPolicy(
    tenantId: number,
    routingKey: string,
    channel: Channel,
    platform: string | null,
  ): Promise<RoutingPolicyRecord | null> {
    if (!isId(tenantId)) return null;
    const em = forkEm(this.orm);
    const found = await em.execute<Row[]>(
      `select id, tenant_id, routing_key, channel, platform, version, enabled, max_attempts,
              ttl_seconds, fallback_enabled
       from routing_policies
       where tenant_id = ? and routing_key = ? and channel = ?
         and platform is not distinct from ?
       order by version desc
       limit 1`,
      [tenantId, routingKey, channel, platform],
    );
    const row = found[0];
    if (!row) return null;
    const providers = await em.execute<Row[]>(
      `select ${INSTANCE_COLUMNS}
       from routing_policy_providers rp
       join provider_instances pi
         on pi.tenant_id = rp.tenant_id and pi.id = rp.provider_instance_id
       where rp.tenant_id = ? and rp.routing_policy_id = ?
       order by rp.position`,
      [tenantId, toId(row.id)],
    );
    return {
      id: toId(row.id),
      tenantId: toId(row.tenant_id),
      routingKey: str(row.routing_key),
      channel: str(row.channel) as Channel,
      platform: strOrNull(row.platform),
      version: num(row.version),
      enabled: bool(row.enabled),
      maxAttempts: num(row.max_attempts),
      ttlSeconds: num(row.ttl_seconds),
      fallbackEnabled: bool(row.fallback_enabled),
      providers: providers.map(toInstance),
    };
  }
}

const EVENT_COLUMNS = `id, tenant_id, provider_instance_id, external_event_id, external_message_id,
  event_type, occurred_at, received_at, delivery_id, processed_at`;

function toEvent(row: Row): StoredProviderEvent {
  return {
    id: toId(row.id),
    tenantId: toId(row.tenant_id),
    providerInstanceId: toId(row.provider_instance_id),
    externalEventId: str(row.external_event_id),
    externalMessageId: strOrNull(row.external_message_id),
    type: str(row.event_type) as NormalizedEventType,
    occurredAt: toDate(row.occurred_at),
    receivedAt: toDate(row.received_at),
    deliveryId: toIdOrNull(row.delivery_id),
    processedAt: toDateOrNull(row.processed_at),
  };
}

/** Delivery correlated through the attempt that recorded the provider's message id. */
function correlateDelivery(alias: string): string {
  return `(
    select a.delivery_id from delivery_attempts a
    where a.tenant_id = ${alias}.tenant_id and a.provider_instance_id = ${alias}.provider_instance_id
      and a.external_reference = ${alias}.external_message_id
    order by a.attempt_number desc
    limit 1
  )`;
}

export class PgProviderEventRepository implements ProviderEventRepository {
  constructor(private readonly orm: Orm) {}

  async record(input: ProviderEventInput): Promise<RecordProviderEventResult> {
    const em = forkEm(this.orm);
    const inserted = await em.execute<Row[]>(
      `insert into provider_events
         (tenant_id, provider_instance_id, external_event_id, external_message_id,
          event_type, occurred_at, received_at, payload, delivery_id)
       select v.tenant_id, v.provider_instance_id, v.external_event_id,
              v.external_message_id, v.event_type, v.occurred_at, v.received_at, v.payload,
              ${correlateDelivery('v')}
       from (select ?::bigint as tenant_id, ?::bigint as provider_instance_id,
                    ?::text as external_event_id, ?::text as external_message_id,
                    ?::text as event_type, ?::timestamptz as occurred_at,
                    ?::timestamptz as received_at, ?::jsonb as payload) v
       on conflict on constraint provider_events_external_event_unique do nothing
       returning ${EVENT_COLUMNS}`,
      [
        input.tenantId,
        input.providerInstanceId,
        input.externalEventId,
        input.externalMessageId,
        input.type,
        input.occurredAt,
        input.receivedAt,
        JSON.stringify(input.payload),
      ],
    );
    if (inserted[0]) return { kind: 'inserted', event: toEvent(inserted[0]) };

    const existing = await em.execute<Row[]>(
      `select ${EVENT_COLUMNS} from provider_events
       where tenant_id = ? and provider_instance_id = ? and external_event_id = ?`,
      [input.tenantId, input.providerInstanceId, input.externalEventId],
    );
    if (!existing[0]) throw new Error('provider event conflict without visible row');
    return { kind: 'duplicate', event: toEvent(existing[0]) };
  }

  async findUnprocessedCorrelated(limit: number): Promise<StoredProviderEvent[]> {
    const found = await forkEm(this.orm).execute<Row[]>(
      `select ${EVENT_COLUMNS} from provider_events
       where processed_at is null and delivery_id is not null
       order by received_at, id
       limit ?`,
      [limit],
    );
    return found.map(toEvent);
  }

  async findUncorrelatedReceivedBefore(
    receivedBefore: Date,
    limit: number,
  ): Promise<StoredProviderEvent[]> {
    const found = await forkEm(this.orm).execute<Row[]>(
      `select ${EVENT_COLUMNS} from provider_events
       where processed_at is null and delivery_id is null and received_at <= ?
       order by received_at, id
       limit ?`,
      [receivedBefore, limit],
    );
    return found.map(toEvent);
  }

  async correlatePending(limit: number): Promise<number> {
    // Only events that actually match an attempt count against the limit: uncorrelatable ones
    // (message id not yet committed, or never) cannot starve the correlation of newer events.
    const result = await forkEm(this.orm).execute<QueryResult>(
      `with pending as (
         select e.id, m.delivery_id
         from provider_events e
         join lateral (
           select a.delivery_id from delivery_attempts a
           where a.tenant_id = e.tenant_id and a.provider_instance_id = e.provider_instance_id
             and a.external_reference = e.external_message_id
           order by a.attempt_number desc
           limit 1
         ) m on true
         where e.delivery_id is null and e.processed_at is null
           and e.external_message_id is not null
         order by e.received_at
         limit ?
         for update of e skip locked
       )
       update provider_events e
       set delivery_id = pending.delivery_id
       from pending
       where e.id = pending.id`,
      [limit],
      'run',
    );
    return result.affectedRows;
  }

  async markProcessed(tenantId: number, eventId: number, at: Date): Promise<boolean> {
    if (!isId(tenantId) || !isId(eventId)) return false;
    const result = await forkEm(this.orm).execute<QueryResult>(
      `update provider_events set processed_at = ?
       where tenant_id = ? and id = ? and processed_at is null`,
      [at, tenantId, eventId],
      'run',
    );
    return result.affectedRows === 1;
  }
}

export class PgDeliveryReceiptRepository implements DeliveryReceiptRepository {
  constructor(private readonly orm: Orm) {}

  async updateReceiptStatus(
    tenantId: number,
    deliveryId: number,
    from: readonly ReceiptStatus[],
    to: ReceiptStatus,
  ): Promise<boolean> {
    if (!isId(tenantId) || !isId(deliveryId) || from.length === 0) return false;
    const result = await forkEm(this.orm).execute<QueryResult>(
      `update deliveries set receipt_status = ?, updated_at = now()
       where tenant_id = ? and id = ? and receipt_status = any(?::text[])`,
      [to, tenantId, deliveryId, `{${from.join(',')}}`],
      'run',
    );
    return result.affectedRows === 1;
  }
}

export class PgSuppressionRepository implements SuppressionRepository {
  constructor(private readonly orm: Orm) {}

  async isSuppressed(tenantId: number, channel: Channel, recipientKey: string): Promise<boolean> {
    if (!isId(tenantId)) return false;
    const found = await forkEm(this.orm).execute<Row[]>(
      `select 1 from suppressions where tenant_id = ? and channel = ? and recipient_key = ?`,
      [tenantId, channel, recipientKey],
    );
    return found.length > 0;
  }

  async add(input: SuppressionInput): Promise<boolean> {
    const result = await forkEm(this.orm).execute<QueryResult>(
      `insert into suppressions
         (tenant_id, channel, recipient_key, reason, source, provider_event_id)
       values (?, ?, ?, ?, ?, ?)
       on conflict on constraint suppressions_recipient_unique do nothing`,
      [
        input.tenantId,
        input.channel,
        input.recipientKey,
        input.reason,
        input.source,
        input.providerEventId,
      ],
      'run',
    );
    return result.affectedRows === 1;
  }
}

export class PgAuditRepository implements AuditRepository {
  constructor(private readonly orm: Orm) {}

  async record(event: AuditEventInput): Promise<void> {
    await forkEm(this.orm).execute<QueryResult>(
      `insert into audit_events
         (tenant_id, actor, operation, resource_type, resource_id, details)
       values (?, ?, ?, ?, ?, ?::jsonb)`,
      [
        event.tenantId,
        event.actor,
        event.operation,
        event.resourceType,
        event.resourceId,
        JSON.stringify(event.details),
      ],
      'run',
    );
  }
}
