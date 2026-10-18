import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { CHANNELS } from '../../contracts/channels.js';
import { API_SCOPES } from '../../contracts/statuses.js';

const strict = { additionalProperties: false } as const;
const Name = Type.String({ pattern: '^[a-z0-9][a-z0-9_.-]{0,63}$' });
const Platform = Type.Union([Type.String({ minLength: 1, maxLength: 32 }), Type.Null()]);

const ApiKeyEntry = Type.Object(
  {
    name: Name,
    scopes: Type.Array(Type.Enum(API_SCOPES), { minItems: 1, uniqueItems: true }),
    expiresAt: Type.Optional(Type.Union([Type.String({ format: 'date-time' }), Type.Null()])),
    revoked: Type.Boolean({ default: false }),
  },
  strict,
);

/** Overrides PROVIDER_RATE_LIMIT_BURST / PROVIDER_RATE_LIMIT_PER_SECOND for one instance. */
const SendRateLimitEntry = Type.Object(
  {
    burst: Type.Integer({ minimum: 1, maximum: 100_000 }),
    perSecond: Type.Number({ exclusiveMinimum: 0, maximum: 100_000 }),
  },
  strict,
);

/** Overrides CIRCUIT_BREAKER_* for one instance; omitted fields keep the env defaults. */
const CircuitBreakerEntry = Type.Object(
  {
    failureThreshold: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000 })),
    failureWindowMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 3_600_000 })),
    openMs: Type.Optional(Type.Integer({ minimum: 1_000, maximum: 3_600_000 })),
  },
  { ...strict, minProperties: 1 },
);

const ProviderInstanceEntry = Type.Object(
  {
    name: Name,
    providerType: Type.String({ pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' }),
    channel: Type.Enum(CHANNELS),
    platform: Type.Optional(Platform),
    /** Non-secret configuration validated by the provider adapter. */
    config: Type.Record(Type.String(), Type.Unknown()),
    /** `env:<PREFIX>` or `file:<name>`; secret values never appear in this file. */
    secretRef: Type.Optional(
      Type.Union([Type.String({ pattern: '^(env|file):[A-Za-z0-9_-]{1,128}$' }), Type.Null()]),
    ),
    enabled: Type.Boolean({ default: true }),
    sendRateLimit: Type.Optional(SendRateLimitEntry),
    circuitBreaker: Type.Optional(CircuitBreakerEntry),
  },
  strict,
);

const RoutingPolicyEntry = Type.Object(
  {
    routingKey: Type.String({ pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' }),
    channel: Type.Enum(CHANNELS),
    platform: Type.Optional(Platform),
    enabled: Type.Boolean({ default: true }),
    maxAttempts: Type.Integer({ minimum: 1, maximum: 100, default: 5 }),
    ttlSeconds: Type.Integer({ minimum: 60, maximum: 30 * 24 * 3600, default: 86_400 }),
    fallbackEnabled: Type.Boolean({ default: true }),
    /** Provider instance names in priority order. */
    providers: Type.Array(Name, { minItems: 1, maxItems: 16, uniqueItems: true }),
  },
  strict,
);

const SenderRule = Type.String({
  pattern: '^([^\\s@<>]+@[A-Za-z0-9.-]+|@[A-Za-z0-9.-]+)$',
  maxLength: 320,
});

const TenantEntry = Type.Object(
  {
    slug: Name,
    name: Type.String({ minLength: 1, maxLength: 200 }),
    status: Type.Enum(['active', 'suspended'], { default: 'active' }),
    /** `user@domain` (exact mailbox) or `@domain` (any mailbox of that domain). */
    allowedSenders: Type.Array(SenderRule, { default: [], maxItems: 200, uniqueItems: true }),
    quotas: Type.Record(Type.String(), Type.Unknown(), { default: {} }),
    apiKeys: Type.Array(ApiKeyEntry, { default: [] }),
    providerInstances: Type.Array(ProviderInstanceEntry, { default: [] }),
    routingPolicies: Type.Array(RoutingPolicyEntry, { default: [] }),
  },
  strict,
);

export const ConfigFileSchema = Type.Object(
  { $schema: Type.Optional(Type.String()), tenants: Type.Array(TenantEntry, { minItems: 1 }) },
  strict,
);
export type ConfigFile = Static<typeof ConfigFileSchema>;
export type TenantEntry = Static<typeof TenantEntry>;

export class ConfigFileError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration file:\n- ${issues.join('\n- ')}`);
    this.name = 'ConfigFileError';
  }
}

/** Applies defaults and validates the structure; messages contain paths only, never values. */
export function parseConfigFile(input: unknown): ConfigFile {
  const candidate: unknown = Value.Default(ConfigFileSchema, structuredClone(input));
  if (!Value.Check(ConfigFileSchema, candidate)) {
    const issues = [...Value.Errors(ConfigFileSchema, candidate)].map(
      (e) => `${e.instancePath || '/'} ${e.message}`,
    );
    throw new ConfigFileError([...new Set(issues)]);
  }
  return candidate;
}
