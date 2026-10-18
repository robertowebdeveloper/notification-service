import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { applyConfig } from '../../../../src/application/admin/apply-config.js';
import { ConfigFileError, parseConfigFile } from '../../../../src/application/admin/config-file.js';
import type {
  AdminConfigRepository,
  ApiKeyConfig,
  ProviderInstanceConfig,
  RoutingPolicyConfig,
  TenantConfig,
} from '../../../../src/application/ports/lookup-repositories.js';
import { createEmailProviderRegistry } from '../../../../src/infrastructure/providers/registry.js';
import { generateApiKey } from '../../../../src/infrastructure/security/api-keys.js';

/** In-memory admin repository with the same "changed only when different" semantics. */
class FakeAdmin implements AdminConfigRepository {
  tenants = new Map<string, { id: string; value: string }>();
  keys = new Map<string, { id: string; value: ApiKeyConfig }>();
  instances = new Map<string, { id: string; value: string }>();
  policies = new Map<string, { id: string; value: string; version: number }>();

  private upsert(map: Map<string, { id: string; value: string }>, key: string, value: string) {
    const existing = map.get(key);
    if (existing?.value === value) return Promise.resolve({ id: existing.id, changed: false });
    const id = existing?.id ?? randomUUID();
    map.set(key, { id, value });
    return Promise.resolve({ id, changed: true });
  }

  upsertTenant(_actor: string, tenant: TenantConfig) {
    return this.upsert(this.tenants, tenant.slug, JSON.stringify(tenant));
  }
  upsertApiKey(_actor: string, tenantId: string, key: ApiKeyConfig) {
    const existing = this.keys.get(`${tenantId}|${key.name}`);
    if (existing && JSON.stringify(existing.value) === JSON.stringify(key)) {
      return Promise.resolve({ id: existing.id, changed: false });
    }
    const id = existing?.id ?? randomUUID();
    this.keys.set(`${tenantId}|${key.name}`, { id, value: key });
    return Promise.resolve({ id, changed: true });
  }
  upsertProviderInstance(_actor: string, tenantId: string, instance: ProviderInstanceConfig) {
    return this.upsert(this.instances, `${tenantId}|${instance.name}`, JSON.stringify(instance));
  }
  publishRoutingPolicy(_actor: string, tenantId: string, policy: RoutingPolicyConfig) {
    const key = `${tenantId}|${policy.routingKey}|${policy.channel}`;
    const existing = this.policies.get(key);
    const value = JSON.stringify(policy);
    if (existing?.value === value) {
      return Promise.resolve({ id: existing.id, changed: false, version: existing.version });
    }
    const next = { id: randomUUID(), value, version: (existing?.version ?? 0) + 1 };
    this.policies.set(key, next);
    return Promise.resolve({ id: next.id, changed: true, version: next.version });
  }
}

function deps(admin: FakeAdmin, appEnv = 'local') {
  return {
    admin,
    apiKeys: {
      findByName: (tenantId: string, name: string) =>
        Promise.resolve(admin.keys.get(`${tenantId}|${name}`)?.value ?? null),
    },
    providers: createEmailProviderRegistry(),
    generateApiKey,
    appEnv,
    actor: 'test',
  };
}

async function exampleFile() {
  return parseConfigFile(JSON.parse(await readFile('config/local.example.json', 'utf8')));
}

describe('config:apply', () => {
  it('applies the local example once and is idempotent afterwards', async () => {
    const admin = new FakeAdmin();
    const file = await exampleFile();
    const first = await applyConfig(file, deps(admin));
    expect(first.changed).toEqual({
      tenants: 1,
      apiKeys: 1,
      providerInstances: 2,
      routingPolicies: 1,
    });
    expect(first.createdApiKeys).toHaveLength(1);
    expect(first.createdApiKeys[0]?.plaintext).toMatch(/^ns_/);

    const tenant = [...admin.tenants.values()][0];
    expect(JSON.parse(tenant?.value ?? '{}')).toMatchObject({
      quotas: { allowedSenders: ['no-reply@example.test', '@notifications.example.test'] },
    });
    const storedKey = [...admin.keys.values()][0]?.value;
    expect(JSON.stringify(storedKey)).not.toContain(first.createdApiKeys[0]?.plaintext);

    const second = await applyConfig(file, deps(admin));
    expect(second.changed).toEqual({
      tenants: 0,
      apiKeys: 0,
      providerInstances: 0,
      routingPolicies: 0,
    });
    expect(second.createdApiKeys).toEqual([]);
  });

  it('rejects local-profile provider instances in stage and production', async () => {
    const file = await exampleFile();
    for (const env of ['stage', 'production']) {
      const error = await applyConfig(file, deps(new FakeAdmin(), env)).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConfigFileError);
      expect((error as ConfigFileError).issues.join('\n')).toMatch(
        /profile "local" is not allowed/,
      );
    }
  });

  it('validates structure, provider configs, secrets and policy references before writing', async () => {
    expect(() => parseConfigFile({ tenants: [{ slug: 'x', name: 'x', extra: true }] })).toThrow(
      ConfigFileError,
    );
    const file = parseConfigFile({
      tenants: [
        {
          slug: 'acme',
          name: 'Acme',
          providerInstances: [
            { name: 'bad-smtp', providerType: 'smtp', channel: 'email', config: { host: 'h' } },
            { name: 'resend', providerType: 'resend', channel: 'email', config: {} },
            { name: 'ghost', providerType: 'carrier-pigeon', channel: 'email', config: {} },
          ],
          routingPolicies: [{ routingKey: 'tx', channel: 'email', providers: ['missing'] }],
        },
      ],
    });
    const admin = new FakeAdmin();
    const error = await applyConfig(file, deps(admin)).catch((e: unknown) => e);
    const issues = (error as ConfigFileError).issues.join('\n');
    expect(issues).toMatch(/providerInstances\/0\/config/);
    expect(issues).toMatch(/providerInstances\/1\/secretRef is required/);
    expect(issues).toMatch(/providerInstances\/2\/providerType/);
    expect(issues).toMatch(/routingPolicies\/0\/providers\/0 is not declared/);
    expect(admin.tenants.size).toBe(0);
  });

  it('persists per-instance send rate and circuit breaker overrides as instance limits', async () => {
    const admin = new FakeAdmin();
    const file = parseConfigFile({
      tenants: [
        {
          slug: 'acme',
          name: 'Acme',
          providerInstances: [
            {
              name: 'smtp-limited',
              providerType: 'smtp',
              channel: 'email',
              config: { host: 'smtp.example.test', port: 587, tlsRequired: true },
              sendRateLimit: { burst: 5, perSecond: 0.5 },
              circuitBreaker: { failureThreshold: 3 },
            },
            {
              name: 'smtp-default',
              providerType: 'smtp',
              channel: 'email',
              config: { host: 'smtp.example.test', port: 587, tlsRequired: true },
            },
          ],
        },
      ],
    });
    await applyConfig(file, deps(admin));
    const stored = [...admin.instances.values()].map(
      (entry) => JSON.parse(entry.value) as { name: string; limits: unknown },
    );
    expect(stored.find((i) => i.name === 'smtp-limited')?.limits).toEqual({
      sendRateLimit: { burst: 5, perSecond: 0.5 },
      circuitBreaker: { failureThreshold: 3 },
    });
    expect(stored.find((i) => i.name === 'smtp-default')?.limits).toEqual({});
  });

  it.each([
    [{ sendRateLimit: { burst: 0, perSecond: 1 } }],
    [{ sendRateLimit: { burst: 5 } }],
    [{ sendRateLimit: { burst: 5, perSecond: 0 } }],
    [{ circuitBreaker: {} }],
    [{ circuitBreaker: { openMs: 10 } }],
    [{ circuitBreaker: { failureThreshold: 2, extra: 1 } }],
  ])('rejects malformed instance limits %o', (limits) => {
    expect(() =>
      parseConfigFile({
        tenants: [
          {
            slug: 'acme',
            name: 'Acme',
            providerInstances: [
              { name: 'smtp', providerType: 'smtp', channel: 'email', config: {}, ...limits },
            ],
          },
        ],
      }),
    ).toThrow(ConfigFileError);
  });

  it('keeps existing keys and applies revocation without printing anything', async () => {
    const admin = new FakeAdmin();
    const file = await exampleFile();
    await applyConfig(file, deps(admin));
    const before = [...admin.keys.values()][0]?.value;
    const tenant = file.tenants[0];
    const key = tenant?.apiKeys[0];
    if (!key) throw new Error('fixture');
    key.revoked = true;
    const result = await applyConfig(file, deps(admin));
    expect(result.changed.apiKeys).toBe(1);
    expect(result.createdApiKeys).toEqual([]);
    const after = [...admin.keys.values()][0]?.value;
    expect(after?.keyHash).toBe(before?.keyHash);
    expect(after?.revoked).toBe(true);
  });
});

describe('config:apply safety', () => {
  it('never un-revokes a key: revoked:false for a revoked key fails the whole run', async () => {
    const admin = new FakeAdmin();
    const file = await exampleFile();
    const key = file.tenants[0]?.apiKeys[0];
    if (!key) throw new Error('fixture');
    key.revoked = true;
    await applyConfig(file, deps(admin));
    key.revoked = false;
    const error = await applyConfig(file, deps(admin)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigFileError);
    expect((error as ConfigFileError).issues.join('\n')).toMatch(
      /apiKeys\/0\/revoked: API key "local-app-key" .* revocation cannot be undone.*new name/,
    );
    expect([...admin.keys.values()][0]?.value.revoked).toBe(true);
  });

  it('applies through the transaction of a transactional repository, all-or-nothing', async () => {
    class TransactionalAdmin extends FakeAdmin {
      transactions = 0;
      failPolicies = false;
      async inTransaction<T>(
        work: (scope: {
          admin: FakeAdmin;
          apiKeys: ReturnType<typeof deps>['apiKeys'];
        }) => Promise<T>,
      ): Promise<T> {
        this.transactions += 1;
        const snapshot = {
          tenants: new Map(this.tenants),
          keys: new Map(this.keys),
          instances: new Map(this.instances),
          policies: new Map(this.policies),
        };
        try {
          return await work({ admin: this, apiKeys: deps(this).apiKeys });
        } catch (error) {
          Object.assign(this, snapshot);
          throw error;
        }
      }
      override publishRoutingPolicy(actor: string, tenantId: string, policy: RoutingPolicyConfig) {
        if (this.failPolicies) return Promise.reject(new Error('injected failure'));
        return super.publishRoutingPolicy(actor, tenantId, policy);
      }
    }
    const admin = new TransactionalAdmin();
    admin.failPolicies = true;
    const file = await exampleFile();
    await expect(applyConfig(file, deps(admin))).rejects.toThrow('injected failure');
    expect(admin.transactions).toBe(1);
    expect(admin.tenants.size + admin.keys.size + admin.instances.size).toBe(0);

    admin.failPolicies = false;
    const result = await applyConfig(file, deps(admin));
    expect(result.createdApiKeys).toHaveLength(1);
    expect(admin.keys.size).toBe(1);
  });

  it('does not report a generated key that another run inserted first', async () => {
    class RacingAdmin extends FakeAdmin {
      override async upsertApiKey(actor: string, tenantId: string, key: ApiKeyConfig) {
        const outcome = await super.upsertApiKey(actor, tenantId, key);
        return { ...outcome, created: false };
      }
    }
    const result = await applyConfig(await exampleFile(), deps(new RacingAdmin()));
    expect(result.createdApiKeys).toEqual([]);
  });
});
