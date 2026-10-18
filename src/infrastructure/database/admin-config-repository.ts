import type { QueryResult } from '@mikro-orm/core';
import type {
  AdminConfigRepository,
  ApiKeyConfig,
  ProviderInstanceConfig,
  RoutingPolicyConfig,
  TenantConfig,
  UpsertOutcome,
} from '../../application/ports/lookup-repositories.js';
import {
  bool,
  forkEm,
  num,
  pgTextArray,
  str,
  toId,
  type Em,
  type Orm,
  type Row,
} from './sql-support.js';

type Tx = Parameters<Parameters<Em['transactional']>[0]>[0];

/** Serializes concurrent `config:apply` runs (transaction-scoped advisory lock). */
const CONFIG_APPLY_LOCK = 'notification-service:config-apply';

export interface ExistingApiKeyState {
  keyPrefix: string;
  keyHash: string;
  revoked: boolean;
}

async function audit(
  tx: Tx,
  actor: string,
  tenantId: number | null,
  operation: string,
  resourceType: string,
  resourceId: number,
  details: Record<string, unknown>,
): Promise<void> {
  await tx.execute<QueryResult>(
    `insert into audit_events (tenant_id, actor, operation, resource_type, resource_id, details)
     values (?, ?, ?, ?, ?, ?::jsonb)`,
    [tenantId, actor, operation, resourceType, String(resourceId), JSON.stringify(details)],
    'run',
  );
}

/**
 * Idempotent configuration writes used by `config:apply`. Updates only happen when a value is
 * distinct from the stored one, so re-applying the same file changes nothing and audits nothing.
 * Secrets never reach the database: only secret_ref and API key hashes are stored. Each method
 * runs in its own transaction, or in the caller's one when obtained through `inTransaction`.
 */
export class PgAdminConfigRepository implements AdminConfigRepository {
  /** `tx`: when set, every method runs inside that (caller-owned) transaction. */
  constructor(
    private readonly orm: Orm,
    private readonly tx?: Tx,
  ) {}

  /**
   * Runs `work` in ONE transaction (all-or-nothing) holding the config:apply advisory lock, with
   * a repository and an API key lookup bound to it.
   */
  async inTransaction<T>(
    work: (scope: {
      admin: PgAdminConfigRepository;
      apiKeys: PgAdminConfigRepository;
    }) => Promise<T>,
  ): Promise<T> {
    if (this.tx !== undefined) return work({ admin: this, apiKeys: this });
    return forkEm(this.orm).transactional(async (tx) => {
      await tx.execute(`select pg_advisory_xact_lock(hashtext(?))`, [CONFIG_APPLY_LOCK]);
      const scoped = new PgAdminConfigRepository(this.orm, tx);
      return work({ admin: scoped, apiKeys: scoped });
    });
  }

  private run<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.tx !== undefined ? work(this.tx) : forkEm(this.orm).transactional(work);
  }

  /** Existing API key of a tenant (hash only) and whether it is revoked. */
  async findByName(tenantId: number, name: string): Promise<ExistingApiKeyState | null> {
    return this.run(async (tx) => {
      const rows = await tx.execute<Row[]>(
        `select key_prefix, key_hash, revoked_at is not null as revoked
         from api_keys where tenant_id = ? and name = ?`,
        [tenantId, name],
      );
      const row = rows[0];
      return row
        ? { keyPrefix: str(row.key_prefix), keyHash: str(row.key_hash), revoked: bool(row.revoked) }
        : null;
    });
  }

  async upsertTenant(actor: string, tenant: TenantConfig): Promise<UpsertOutcome> {
    return this.run(async (tx) => {
      const quotas = JSON.stringify(tenant.quotas);
      const inserted = await tx.execute<Row[]>(
        `insert into tenants (slug, name, status, quotas) values (?, ?, ?, ?::jsonb)
         on conflict on constraint tenants_slug_unique do nothing returning id`,
        [tenant.slug, tenant.name, tenant.status, quotas],
      );
      if (inserted[0]) {
        const id = toId(inserted[0].id);
        await audit(tx, actor, id, 'tenant.created', 'tenant', id, { slug: tenant.slug });
        return { id, changed: true };
      }
      const updated = await tx.execute<Row[]>(
        `update tenants set name = ?, status = ?, quotas = ?::jsonb, updated_at = now()
         where slug = ? and (name, status, quotas) is distinct from (?, ?, ?::jsonb)
         returning id`,
        [tenant.name, tenant.status, quotas, tenant.slug, tenant.name, tenant.status, quotas],
      );
      if (updated[0]) {
        const id = toId(updated[0].id);
        await audit(tx, actor, id, 'tenant.updated', 'tenant', id, {
          slug: tenant.slug,
          status: tenant.status,
        });
        return { id, changed: true };
      }
      const existing = await tx.execute<Row[]>(`select id from tenants where slug = ?`, [
        tenant.slug,
      ]);
      return { id: toId(existing[0]?.id), changed: false };
    });
  }

  /**
   * Creates the key (with the given hash) or updates scopes, expiry and revocation of an existing
   * one. Never replaces the hash of an existing key (a concurrent run's generated key is simply
   * not stored: `created` is false) and never clears a revocation (revocation is one-way).
   */
  async upsertApiKey(
    actor: string,
    tenantId: number,
    key: ApiKeyConfig,
  ): Promise<UpsertOutcome & { created: boolean }> {
    return this.run(async (tx) => {
      const scopes = pgTextArray(key.scopes);
      const inserted = await tx.execute<Row[]>(
        `insert into api_keys (tenant_id, name, key_prefix, key_hash, scopes, expires_at, revoked_at)
         values (?, ?, ?, ?, ?::text[], ?, case when ? then now() end)
         on conflict on constraint api_keys_tenant_id_name_unique do nothing returning id`,
        [tenantId, key.name, key.keyPrefix, key.keyHash, scopes, key.expiresAt, key.revoked],
      );
      const details = { name: key.name, keyPrefix: key.keyPrefix, scopes: key.scopes };
      if (inserted[0]) {
        const id = toId(inserted[0].id);
        await audit(tx, actor, tenantId, 'api_key.created', 'api_key', id, details);
        return { id, changed: true, created: true };
      }
      const updated = await tx.execute<Row[]>(
        `update api_keys
         set scopes = ?::text[], expires_at = ?,
             revoked_at = case when ? then coalesce(revoked_at, now()) else revoked_at end
         where tenant_id = ? and name = ?
           and (scopes, expires_at, revoked_at is not null)
               is distinct from (?::text[], ?::timestamptz, revoked_at is not null or ?::boolean)
         returning id, key_prefix, revoked_at is not null as revoked`,
        [
          scopes,
          key.expiresAt,
          key.revoked,
          tenantId,
          key.name,
          scopes,
          key.expiresAt,
          key.revoked,
        ],
      );
      if (updated[0]) {
        const id = toId(updated[0].id);
        await audit(tx, actor, tenantId, 'api_key.updated', 'api_key', id, {
          name: key.name,
          keyPrefix: str(updated[0].key_prefix),
          scopes: key.scopes,
          revoked: bool(updated[0].revoked),
        });
        return { id, changed: true, created: false };
      }
      const existing = await tx.execute<Row[]>(
        `select id from api_keys where tenant_id = ? and name = ?`,
        [tenantId, key.name],
      );
      return { id: toId(existing[0]?.id), changed: false, created: false };
    });
  }

  async upsertProviderInstance(
    actor: string,
    tenantId: number,
    instance: ProviderInstanceConfig,
  ): Promise<UpsertOutcome> {
    return this.run(async (tx) => {
      const config = JSON.stringify(instance.config);
      const values = [
        instance.providerType,
        instance.channel,
        instance.platform,
        config,
        instance.secretRef,
        instance.enabled,
        JSON.stringify(instance.limits),
      ];
      const inserted = await tx.execute<Row[]>(
        `insert into provider_instances
           (tenant_id, name, provider_type, channel, platform, config, secret_ref, enabled, limits)
         values (?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?::jsonb)
         on conflict on constraint provider_instances_tenant_id_name_unique do nothing
         returning id`,
        [tenantId, instance.name, ...values],
      );
      const details = {
        name: instance.name,
        providerType: instance.providerType,
        channel: instance.channel,
        enabled: instance.enabled,
        limits: instance.limits,
      };
      if (inserted[0]) {
        const id = toId(inserted[0].id);
        await audit(tx, actor, tenantId, 'provider_instance.created', 'provider_instance', id, {
          ...details,
          revision: 1,
        });
        return { id, changed: true };
      }
      const updated = await tx.execute<Row[]>(
        `update provider_instances
         set provider_type = ?, channel = ?, platform = ?, config = ?::jsonb, secret_ref = ?,
             enabled = ?, limits = ?::jsonb, revision = revision + 1, updated_at = now()
         where tenant_id = ? and name = ?
           and (provider_type, channel, platform, config, secret_ref, enabled, limits)
               is distinct from
               (?::text, ?::text, ?::text, ?::jsonb, ?::text, ?::boolean, ?::jsonb)
         returning id, revision`,
        [...values, tenantId, instance.name, ...values],
      );
      if (updated[0]) {
        const id = toId(updated[0].id);
        await audit(tx, actor, tenantId, 'provider_instance.updated', 'provider_instance', id, {
          ...details,
          revision: num(updated[0].revision),
        });
        return { id, changed: true };
      }
      const existing = await tx.execute<Row[]>(
        `select id from provider_instances where tenant_id = ? and name = ?`,
        [tenantId, instance.name],
      );
      return { id: toId(existing[0]?.id), changed: false };
    });
  }

  async publishRoutingPolicy(
    actor: string,
    tenantId: number,
    policy: RoutingPolicyConfig,
  ): Promise<UpsertOutcome & { version: number }> {
    return this.run(async (tx) => {
      const instances = await tx.execute<Row[]>(
        `select id, name from provider_instances where tenant_id = ? and name = any(?::text[])`,
        [tenantId, pgTextArray(policy.providerNames)],
      );
      const idByName = new Map(instances.map((r) => [str(r.name), toId(r.id)]));
      const providerIds = policy.providerNames.map((name) => {
        const id = idByName.get(name);
        if (id === undefined) throw new Error(`Unknown provider instance for tenant: ${name}`);
        return id;
      });

      const latestRows = await tx.execute<Row[]>(
        `select p.id, p.version, p.enabled, p.max_attempts, p.ttl_seconds, p.fallback_enabled,
                coalesce((select string_agg(rp.provider_instance_id::text, ',' order by rp.position)
                          from routing_policy_providers rp
                          where rp.tenant_id = p.tenant_id and rp.routing_policy_id = p.id), '')
                  as provider_ids
         from routing_policies p
         where p.tenant_id = ? and p.routing_key = ? and p.channel = ?
           and p.platform is not distinct from ?
         order by p.version desc
         limit 1
         for update`,
        [tenantId, policy.routingKey, policy.channel, policy.platform],
      );
      const latest = latestRows[0];
      if (
        latest &&
        bool(latest.enabled) === policy.enabled &&
        num(latest.max_attempts) === policy.maxAttempts &&
        num(latest.ttl_seconds) === policy.ttlSeconds &&
        bool(latest.fallback_enabled) === policy.fallbackEnabled &&
        str(latest.provider_ids) === providerIds.join(',')
      ) {
        return { id: toId(latest.id), changed: false, version: num(latest.version) };
      }

      const version = latest ? num(latest.version) + 1 : 1;
      const insertedPolicy = await tx.execute<Row[]>(
        `insert into routing_policies
           (tenant_id, routing_key, channel, platform, version, enabled, max_attempts,
            ttl_seconds, fallback_enabled)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)
         returning id`,
        [
          tenantId,
          policy.routingKey,
          policy.channel,
          policy.platform,
          version,
          policy.enabled,
          policy.maxAttempts,
          policy.ttlSeconds,
          policy.fallbackEnabled,
        ],
      );
      const id = toId(insertedPolicy[0]?.id);
      for (const [position, providerId] of providerIds.entries()) {
        await tx.execute<QueryResult>(
          `insert into routing_policy_providers
             (routing_policy_id, position, tenant_id, provider_instance_id)
           values (?, ?, ?, ?)`,
          [id, position, tenantId, providerId],
          'run',
        );
      }
      await audit(tx, actor, tenantId, 'routing_policy.published', 'routing_policy', id, {
        routingKey: policy.routingKey,
        channel: policy.channel,
        platform: policy.platform,
        version,
        providers: policy.providerNames,
      });
      return { id, changed: true, version };
    });
  }
}
