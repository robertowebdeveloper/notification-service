import type {
  ConfigValidationResult,
  ProviderCapabilities,
} from '../../contracts/provider-port.js';
import type {
  AdminConfigRepository,
  ApiKeyConfig,
  UpsertOutcome,
} from '../ports/lookup-repositories.js';
import { ConfigFileError, type ConfigFile, type TenantEntry } from './config-file.js';

/** Structural subset of the provider registry. */
export interface ProviderCatalog {
  has(providerType: string): boolean;
  capabilities(providerType: string): ProviderCapabilities;
  validateConfig(providerType: string, config: unknown): ConfigValidationResult<unknown>;
  requiredSecretsFor(providerType: string, validatedConfig: unknown): readonly string[];
}

export interface ApiKeyLookup {
  /** `revoked` is optional for lookups that cannot tell (the repository enforces it anyway). */
  findByName(
    tenantId: string,
    name: string,
  ): Promise<{ keyPrefix: string; keyHash: string; revoked?: boolean } | null>;
}

/** Admin writes; `created` (when reported) tells whether the key row was actually inserted. */
export interface AdminConfigWriter extends AdminConfigRepository {
  upsertApiKey(
    actor: string,
    tenantId: string,
    key: ApiKeyConfig,
  ): Promise<UpsertOutcome & { created?: boolean }>;
}

export interface ApplyConfigScope {
  admin: AdminConfigWriter;
  apiKeys: ApiKeyLookup;
}

/** Runs the whole application in one transaction: either everything is applied or nothing. */
export interface ApplyConfigTransactions {
  inTransaction<T>(work: (scope: ApplyConfigScope) => Promise<T>): Promise<T>;
}

function transactionsOf(admin: object): ApplyConfigTransactions | undefined {
  const candidate = admin as Partial<ApplyConfigTransactions>;
  return typeof candidate.inTransaction === 'function'
    ? (admin as ApplyConfigTransactions)
    : undefined;
}

export interface ApiKeyFactory {
  (): { plaintext: string; keyPrefix: string; keyHash: string };
}

export interface ApplyConfigDeps {
  /**
   * When `admin` also implements `inTransaction` (the PostgreSQL repository does), the whole
   * file is applied atomically through it and `apiKeys` is replaced by the transaction's lookup.
   */
  admin: AdminConfigWriter;
  apiKeys: ApiKeyLookup;
  providers: ProviderCatalog;
  generateApiKey: ApiKeyFactory;
  appEnv: string;
  actor: string;
}

export interface CreatedApiKey {
  tenant: string;
  name: string;
  /** Shown once; only its hash is stored. */
  plaintext: string;
}

export interface ApplyConfigResult {
  changed: { tenants: number; apiKeys: number; providerInstances: number; routingPolicies: number };
  createdApiKeys: CreatedApiKey[];
}

const REMOTE_ENVIRONMENTS = new Set(['stage', 'production']);

function platformOf(platform: string | null | undefined): string | null {
  return platform ?? null;
}

/** Cross-field checks done before any write, so an invalid file changes nothing. */
export function validateSemantics(
  file: ConfigFile,
  deps: Pick<ApplyConfigDeps, 'providers' | 'appEnv'>,
): string[] {
  const issues: string[] = [];
  const remote = REMOTE_ENVIRONMENTS.has(deps.appEnv);
  const slugs = new Set<string>();

  file.tenants.forEach((tenant, t) => {
    const at = `/tenants/${t}`;
    if (slugs.has(tenant.slug)) issues.push(`${at}/slug duplicated`);
    slugs.add(tenant.slug);

    const keyNames = new Set<string>();
    tenant.apiKeys.forEach((key, k) => {
      if (keyNames.has(key.name)) issues.push(`${at}/apiKeys/${k}/name duplicated`);
      keyNames.add(key.name);
    });

    const instances = new Map<string, { channel: string; platform: string | null }>();
    tenant.providerInstances.forEach((instance, i) => {
      const path = `${at}/providerInstances/${i}`;
      if (instances.has(instance.name)) issues.push(`${path}/name duplicated`);
      const platform = platformOf(instance.platform);
      instances.set(instance.name, { channel: instance.channel, platform });
      if ((instance.channel === 'email' || instance.channel === 'sms') && platform !== null) {
        issues.push(`${path}/platform must be null for channel ${instance.channel}`);
      }
      if (!deps.providers.has(instance.providerType)) {
        issues.push(`${path}/providerType is not a registered provider type`);
        return;
      }
      const capabilities = deps.providers.capabilities(instance.providerType);
      if (!capabilities.channels.includes(instance.channel)) {
        issues.push(`${path}/channel is not supported by the provider type`);
      }
      if (platform !== null && !capabilities.platforms.includes(platform)) {
        issues.push(`${path}/platform is not supported by the provider type`);
      }
      const validated = deps.providers.validateConfig(instance.providerType, instance.config);
      if (!validated.ok) {
        for (const error of validated.errors) issues.push(`${path}/config${error}`);
        return;
      }
      const profile = (validated.config as { profile?: unknown }).profile;
      if (remote && profile === 'local') {
        issues.push(`${path}/config/profile "local" is not allowed in ${deps.appEnv}`);
      }
      const secrets = deps.providers.requiredSecretsFor(instance.providerType, validated.config);
      if (secrets.length > 0 && (instance.secretRef === undefined || instance.secretRef === null)) {
        issues.push(`${path}/secretRef is required (secrets: ${secrets.join(', ')})`);
      }
    });

    const routes = new Set<string>();
    tenant.routingPolicies.forEach((policy, p) => {
      const path = `${at}/routingPolicies/${p}`;
      const platform = platformOf(policy.platform);
      const routeKey = `${policy.routingKey}|${policy.channel}|${platform ?? ''}`;
      if (routes.has(routeKey)) issues.push(`${path} duplicated route`);
      routes.add(routeKey);
      if ((policy.channel === 'email' || policy.channel === 'sms') && platform !== null) {
        issues.push(`${path}/platform must be null for channel ${policy.channel}`);
      }
      policy.providers.forEach((name, n) => {
        const instance = instances.get(name);
        if (instance === undefined) {
          issues.push(`${path}/providers/${n} is not declared in providerInstances`);
        } else if (instance.channel !== policy.channel || instance.platform !== platform) {
          issues.push(`${path}/providers/${n} serves another channel or platform`);
        }
      });
    });
  });
  // Adapter checks (deployment policy) and the profile check above may report the same issue.
  return [...new Set(issues)];
}

/**
 * Idempotent application of the operator configuration file: re-applying the same file changes
 * nothing. Existing API keys are kept (never rotated); new keys are generated and returned once.
 * With a transactional `admin` the file is applied all-or-nothing and the result (with the new
 * keys) is returned only after the commit, so a failure can never leave a stored key unshown.
 * Revocation is one-way: a revoked key listed with `revoked: false` fails the whole run.
 */
export async function applyConfig(
  file: ConfigFile,
  deps: ApplyConfigDeps,
): Promise<ApplyConfigResult> {
  const issues = validateSemantics(file, deps);
  if (issues.length > 0) throw new ConfigFileError(issues);

  const apply = async (scope: ApplyConfigScope): Promise<ApplyConfigResult> => {
    const result: ApplyConfigResult = {
      changed: { tenants: 0, apiKeys: 0, providerInstances: 0, routingPolicies: 0 },
      createdApiKeys: [],
    };
    for (const [index, tenant] of file.tenants.entries()) {
      await applyTenant(tenant, `/tenants/${index}`, { ...deps, ...scope }, result);
    }
    return result;
  };
  const transactions = transactionsOf(deps.admin);
  return transactions === undefined
    ? apply({ admin: deps.admin, apiKeys: deps.apiKeys })
    : transactions.inTransaction(apply);
}

async function applyTenant(
  tenant: TenantEntry,
  at: string,
  deps: ApplyConfigDeps,
  result: ApplyConfigResult,
): Promise<void> {
  const { admin, actor } = deps;
  const upserted = await admin.upsertTenant(actor, {
    slug: tenant.slug,
    name: tenant.name,
    status: tenant.status,
    // Allowed senders live in the operator-managed tenant JSON (see PgSenderPolicyRepository).
    quotas: { ...tenant.quotas, allowedSenders: tenant.allowedSenders },
  });
  const tenantId = upserted.id;
  if (upserted.changed) result.changed.tenants += 1;

  for (const [index, key] of tenant.apiKeys.entries()) {
    const existing = await deps.apiKeys.findByName(tenantId, key.name);
    if (existing?.revoked === true && !key.revoked) {
      throw new ConfigFileError([
        `${at}/apiKeys/${index}/revoked: API key "${key.name}" of tenant "${tenant.slug}" is ` +
          'revoked and revocation cannot be undone; keep "revoked": true and issue a new key ' +
          'under a new name',
      ]);
    }
    const generated = existing === null ? deps.generateApiKey() : null;
    const outcome = await admin.upsertApiKey(actor, tenantId, {
      name: key.name,
      keyPrefix: existing?.keyPrefix ?? generated?.keyPrefix ?? '',
      keyHash: existing?.keyHash ?? generated?.keyHash ?? '',
      scopes: key.scopes,
      expiresAt:
        key.expiresAt === undefined || key.expiresAt === null ? null : new Date(key.expiresAt),
      revoked: key.revoked,
    });
    if (outcome.changed) result.changed.apiKeys += 1;
    // `created === false`: another run inserted this key first; our generated key was not stored.
    if (generated !== null && outcome.created !== false && !key.revoked) {
      result.createdApiKeys.push({
        tenant: tenant.slug,
        name: key.name,
        plaintext: generated.plaintext,
      });
    }
  }

  for (const instance of tenant.providerInstances) {
    const outcome = await admin.upsertProviderInstance(actor, tenantId, {
      name: instance.name,
      providerType: instance.providerType,
      channel: instance.channel,
      platform: platformOf(instance.platform),
      config: instance.config,
      secretRef: instance.secretRef ?? null,
      enabled: instance.enabled,
      limits: {
        ...(instance.sendRateLimit === undefined ? {} : { sendRateLimit: instance.sendRateLimit }),
        ...(instance.circuitBreaker === undefined
          ? {}
          : { circuitBreaker: instance.circuitBreaker }),
      },
    });
    if (outcome.changed) result.changed.providerInstances += 1;
  }

  for (const policy of tenant.routingPolicies) {
    const outcome = await admin.publishRoutingPolicy(actor, tenantId, {
      routingKey: policy.routingKey,
      channel: policy.channel,
      platform: platformOf(policy.platform),
      enabled: policy.enabled,
      maxAttempts: policy.maxAttempts,
      ttlSeconds: policy.ttlSeconds,
      fallbackEnabled: policy.fallbackEnabled,
      providerNames: policy.providers,
    });
    if (outcome.changed) result.changed.routingPolicies += 1;
  }
}
