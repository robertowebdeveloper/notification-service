import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ApiScope } from '../../../src/contracts/statuses.js';
import type { E2eDatabase } from './database.js';
import { runToCompletion } from './processes.js';

/**
 * Tenant seeding behind a small interface so the mechanism can be switched without touching the
 * scenarios. The default goes through the real admin command `config:apply -- --file <path>`
 * with a file in the format of `tests/e2e/fixtures/config.example.json`.
 */
export interface ApiKeySpec {
  name: string;
  scopes: ApiScope[];
}

export interface ProviderInstanceSpec {
  name: string;
  providerType: 'smtp' | 'resend';
  channel: 'email';
  platform: null;
  config: Record<string, unknown>;
  secretRef: string | null;
  enabled: boolean;
  /** Per-instance token bucket shared by all workers (config:apply `sendRateLimit`). */
  sendRateLimit?: { burst: number; perSecond: number };
  circuitBreaker?: { failureThreshold?: number; failureWindowMs?: number; openMs?: number };
}

export interface RoutingPolicySpec {
  routingKey: string;
  channel: 'email';
  platform: null;
  enabled: boolean;
  maxAttempts: number;
  ttlSeconds: number;
  fallbackEnabled: boolean;
  /** Provider instance names in priority order. */
  providers: string[];
}

export interface TenantSpec {
  slug: string;
  name: string;
  /** `user@domain` or `@domain`; defaults to `@example.test` (the suite's sender domain). */
  allowedSenders?: string[];
  apiKeys: ApiKeySpec[];
  providerInstances: ProviderInstanceSpec[];
  routingPolicies: RoutingPolicySpec[];
}

export interface SeededTenant {
  slug: string;
  tenantId: number;
  /** Plain API keys by key name (printed once by config:apply). */
  apiKeys: Record<string, string>;
  /** Provider instance ids by instance name. */
  providerInstanceIds: Record<string, number>;
  /** The first API key of the spec. */
  apiKey: string;
}

export interface TenantSeeder {
  seed(spec: TenantSpec): Promise<SeededTenant>;
}

export const ALL_SCOPES: ApiScope[] = [
  'notifications:write',
  'notifications:read',
  'notifications:retry',
];

/** Builds the config:apply document for one tenant. */
export function toConfigDocument(spec: TenantSpec): Record<string, unknown> {
  return {
    tenants: [
      {
        slug: spec.slug,
        name: spec.name,
        status: 'active',
        allowedSenders: spec.allowedSenders ?? ['@example.test'],
        quotas: {},
        apiKeys: spec.apiKeys,
        providerInstances: spec.providerInstances,
        routingPolicies: spec.routingPolicies,
      },
    ],
  };
}

const TOKEN = /[A-Za-z0-9_\-.~+/=]{20,}/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_FIELD = /^(key|apiKey|api_key|plaintext|plainKey|secret|token|value)$/i;
const NAME_FIELD = /^(name|keyName|apiKeyName|api_key_name)$/i;

function findInJson(value: unknown, wanted: string, inherited: boolean): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findInJson(item, wanted, inherited);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  const named = inherited || entries.some(([k, v]) => NAME_FIELD.test(k) && v === wanted);
  if (named) {
    for (const [k, v] of entries) {
      if (SECRET_FIELD.test(k) && typeof v === 'string' && v.length >= 20 && !UUID.test(v)) {
        return v;
      }
    }
  }
  for (const [k, v] of entries) {
    // `{ "<keyName>": "<secret>" }` maps are accepted too.
    if (k === wanted && typeof v === 'string' && v.length >= 20) return v;
    const found = findInJson(v, wanted, named && typeof v === 'object');
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Extracts the plain API keys printed once by config:apply. The output format is owned by 2A, so
 * the parser accepts JSON log lines (any object carrying the key name and a key/secret/token
 * field) and plain text lines mentioning the key name followed by a long token.
 */
export function extractApiKeys(output: string, names: string[]): Record<string, string> {
  const keys: Record<string, string> = {};
  const lines = output.split('\n');
  for (const name of names) {
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.includes(name)) continue;
      let found: string | undefined;
      if (trimmed.startsWith('{')) {
        try {
          found = findInJson(JSON.parse(trimmed), name, false);
        } catch {
          found = undefined;
        }
      }
      if (found === undefined && !trimmed.startsWith('{')) {
        const tail = trimmed.slice(trimmed.indexOf(name) + name.length);
        found = (tail.match(TOKEN) ?? [])
          .filter((t) => !UUID.test(t))
          .sort((a, b) => b.length - a.length)[0];
      }
      if (found !== undefined) {
        keys[name] = found;
        break;
      }
    }
  }
  return keys;
}

export class ConfigApplySeeder implements TenantSeeder {
  constructor(
    private readonly db: E2eDatabase,
    private readonly env: () => Record<string, string>,
  ) {}

  async seed(spec: TenantSpec): Promise<SeededTenant> {
    const dir = await mkdtemp(path.join(tmpdir(), 'notification-e2e-'));
    const file = path.join(dir, `${spec.slug}.json`);
    try {
      await writeFile(file, JSON.stringify(toConfigDocument(spec), null, 2));
      const run = await runToCompletion('config-apply', {
        name: `config-apply-${spec.slug}`,
        env: this.env(),
        args: ['--file', file],
      });
      if (run.exit.code !== 0) {
        throw new Error(
          `[blocked: 2A config:apply] exited with ${String(run.exit.code)} for ${spec.slug}\n${run.lines.slice(-30).join('\n')}`,
        );
      }
      const names = spec.apiKeys.map((k) => k.name);
      const apiKeys = extractApiKeys(run.output, names);
      const missing = names.filter((n) => apiKeys[n] === undefined);
      if (missing.length > 0) {
        throw new Error(
          `[blocked: 2A config:apply] could not find the printed API keys ${missing.join(', ')} in the output\n${run.lines.slice(-30).join('\n')}`,
        );
      }
      return await this.lookup(spec, apiKeys);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  private async lookup(spec: TenantSpec, apiKeys: Record<string, string>): Promise<SeededTenant> {
    const tenant = await this.db.one<{ id: number }>('select id from tenants where slug = ?', [
      spec.slug,
    ]);
    if (tenant === undefined) throw new Error(`config:apply did not create tenant ${spec.slug}`);
    const instances = await this.db.query<{ id: number; name: string }>(
      'select id, name from provider_instances where tenant_id = ?',
      [tenant.id],
    );
    const firstKey = spec.apiKeys[0]?.name;
    const apiKey = firstKey === undefined ? undefined : apiKeys[firstKey];
    if (apiKey === undefined) throw new Error('TenantSpec needs at least one API key');
    return {
      slug: spec.slug,
      tenantId: tenant.id,
      apiKeys,
      providerInstanceIds: Object.fromEntries(instances.map((i) => [i.name, i.id])),
      apiKey,
    };
  }
}
