import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyConfig,
  type ApplyConfigScope,
  type ApplyConfigTransactions,
} from '../../../src/application/admin/apply-config.js';
import { ConfigFileError, parseConfigFile } from '../../../src/application/admin/config-file.js';
import { PgApiKeyAdminLookup } from '../../../src/infrastructure/database/api-support-repositories.js';
import { createRepositories } from '../../../src/infrastructure/database/repositories.js';
import { createEmailProviderRegistry } from '../../../src/infrastructure/providers/registry.js';
import { generateApiKey, verifyApiKey } from '../../../src/infrastructure/security/api-keys.js';
import { closeOrm, migratedOrm, queryRows } from './support.js';

function tenantFile(slug: string, revoked = false) {
  return parseConfigFile({
    tenants: [
      {
        slug,
        name: `Tenant ${slug}`,
        allowedSenders: ['@example.test'],
        apiKeys: [
          { name: 'primary', scopes: ['notifications:write'], revoked },
          { name: 'reader', scopes: ['notifications:read'] },
        ],
        providerInstances: [
          {
            name: 'smtp',
            providerType: 'smtp',
            channel: 'email',
            config: { host: 'smtp.example.test', port: 587 },
          },
        ],
        routingPolicies: [{ routingKey: 'transactional', channel: 'email', providers: ['smtp'] }],
      },
    ],
  });
}

async function countFor(orm: MikroORM, slug: string) {
  const rows = await queryRows(
    orm,
    `select
       (select count(*)::int from tenants where slug = ?) as tenants,
       (select count(*)::int from api_keys k join tenants t on t.id = k.tenant_id
         where t.slug = ?) as keys,
       (select count(*)::int from provider_instances p join tenants t on t.id = p.tenant_id
         where t.slug = ?) as instances,
       (select count(*)::int from audit_events a join tenants t on t.id = a.tenant_id
         where t.slug = ?) as audits`,
    [slug, slug, slug, slug],
  );
  return rows[0];
}

describe('config:apply atomicity and revocation against PostgreSQL', () => {
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await migratedOrm();
  });
  afterAll(async () => {
    await closeOrm();
  });

  function deps(admin = createRepositories(orm).adminConfig) {
    return {
      admin,
      apiKeys: new PgApiKeyAdminLookup(orm),
      providers: createEmailProviderRegistry({ environment: 'test' }),
      generateApiKey,
      appEnv: 'test',
      actor: 'config:apply',
    };
  }

  it('rolls back everything, keys included, when a later write fails', async () => {
    const slug = `atomic-${randomUUID().slice(0, 8)}`;
    const real = createRepositories(orm).adminConfig;
    // Same transaction as the real repository, with a failure injected after keys, tenant and
    // provider instances were written.
    const failing: ApplyConfigTransactions = {
      inTransaction: (work) =>
        real.inTransaction((scope) => {
          const sabotaged: ApplyConfigScope = {
            apiKeys: scope.apiKeys,
            admin: Object.assign(Object.create(scope.admin) as typeof scope.admin, {
              publishRoutingPolicy: () => Promise.reject(new Error('injected failure')),
            }),
          };
          return work(sabotaged);
        }),
    };
    const admin = Object.assign(Object.create(real) as typeof real, failing);
    await expect(applyConfig(tenantFile(slug), deps(admin))).rejects.toThrow('injected failure');
    expect(await countFor(orm, slug)).toEqual({ tenants: 0, keys: 0, instances: 0, audits: 0 });

    // The same file then applies cleanly and every printed key is the stored one.
    const result = await applyConfig(tenantFile(slug), deps());
    expect(result.createdApiKeys.map((k) => k.name).sort()).toEqual(['primary', 'reader']);
    for (const created of result.createdApiKeys) {
      const rows = await queryRows(
        orm,
        `select key_hash from api_keys where name = ? and tenant_id = (select id from tenants where slug = ?)`,
        [created.name, slug],
      );
      expect(verifyApiKey(created.plaintext, String(rows[0]?.key_hash))).toBe(true);
    }
  });

  it('keeps revocation one-way and never replaces an existing key hash', async () => {
    const slug = `revoke-${randomUUID().slice(0, 8)}`;
    await applyConfig(tenantFile(slug), deps());
    await applyConfig(tenantFile(slug, true), deps());
    const before = await queryRows(
      orm,
      `select k.id, k.key_hash, k.revoked_at from api_keys k join tenants t on t.id = k.tenant_id
       where t.slug = ? and k.name = 'primary'`,
      [slug],
    );
    expect(before[0]?.revoked_at).not.toBeNull();

    const error = await applyConfig(tenantFile(slug, false), deps()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigFileError);
    expect((error as ConfigFileError).issues.join('\n')).toMatch(/revocation cannot be undone/);

    // Even a direct repository call with a different hash and revoked:false changes neither.
    const tenantId = String(
      (await queryRows(orm, `select id from tenants where slug = ?`, [slug]))[0]?.id,
    );
    const forged = generateApiKey();
    await createRepositories(orm).adminConfig.upsertApiKey('test', tenantId, {
      name: 'primary',
      keyPrefix: forged.keyPrefix,
      keyHash: forged.keyHash,
      scopes: ['notifications:write'],
      expiresAt: null,
      revoked: false,
    });
    const after = await queryRows(orm, `select key_hash, revoked_at from api_keys where id = ?`, [
      before[0]?.id,
    ]);
    expect(after[0]?.key_hash).toBe(before[0]?.key_hash);
    expect(String(after[0]?.revoked_at)).toBe(String(before[0]?.revoked_at));
  });

  it('serializes concurrent runs: each new key is created and printed exactly once', async () => {
    const slug = `race-${randomUUID().slice(0, 8)}`;
    const results = await Promise.all(
      Array.from({ length: 3 }, () => applyConfig(tenantFile(slug), deps())),
    );
    const printed = results.flatMap((r) => r.createdApiKeys);
    expect(printed.map((k) => k.name).sort()).toEqual(['primary', 'reader']);
    for (const created of printed) {
      const rows = await queryRows(
        orm,
        `select key_hash from api_keys k join tenants t on t.id = k.tenant_id
         where t.slug = ? and k.name = ?`,
        [slug, created.name],
      );
      expect(verifyApiKey(created.plaintext, String(rows[0]?.key_hash))).toBe(true);
    }
  });
});
