import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderEventInput } from '../../../src/application/ports/lookup-repositories.js';
import {
  createRepositories,
  type Repositories,
} from '../../../src/infrastructure/database/repositories.js';
import {
  closeOrm,
  createTenantFixture,
  deliveryIdOf,
  migratedOrm,
  notificationInput,
  queryRows,
} from './support.js';

describe('lookup and admin repositories', () => {
  let orm: MikroORM;
  let repos: Repositories;

  beforeAll(async () => {
    orm = await migratedOrm();
    repos = createRepositories(orm);
  });

  afterAll(closeOrm);

  async function configuredTenant() {
    const slug = `tenant-${randomUUID()}`;
    const tenant = await repos.adminConfig.upsertTenant('operator', {
      slug,
      name: 'Shop',
      status: 'active',
      quotas: { perMinute: 100 },
    });
    const smtp = await repos.adminConfig.upsertProviderInstance('operator', tenant.id, {
      name: 'smtp-main',
      providerType: 'smtp',
      channel: 'email',
      platform: null,
      config: { host: 'mailpit', port: 1025 },
      secretRef: 'smtp-main',
      enabled: true,
      limits: {},
    });
    const resend = await repos.adminConfig.upsertProviderInstance('operator', tenant.id, {
      name: 'resend-main',
      providerType: 'resend',
      channel: 'email',
      platform: null,
      config: {},
      secretRef: 'resend-main',
      enabled: true,
      limits: {},
    });
    return { slug, tenantId: tenant.id, smtpId: smtp.id, resendId: resend.id };
  }

  it('applies admin configuration idempotently and audits only real changes', async () => {
    const { slug, tenantId } = await configuredTenant();

    const again = await repos.adminConfig.upsertTenant('operator', {
      slug,
      name: 'Shop',
      status: 'active',
      quotas: { perMinute: 100 },
    });
    expect(again).toEqual({ id: tenantId, changed: false });

    const unchanged = await repos.adminConfig.upsertProviderInstance('operator', tenantId, {
      name: 'smtp-main',
      providerType: 'smtp',
      channel: 'email',
      platform: null,
      config: { port: 1025, host: 'mailpit' },
      secretRef: 'smtp-main',
      enabled: true,
      limits: {},
    });
    expect(unchanged.changed).toBe(false);
    const disabled = await repos.adminConfig.upsertProviderInstance('operator', tenantId, {
      name: 'smtp-main',
      providerType: 'smtp',
      channel: 'email',
      platform: null,
      config: { port: 1025, host: 'mailpit' },
      secretRef: 'smtp-main',
      enabled: false,
      limits: {},
    });
    expect(disabled.changed).toBe(true);
    expect(await repos.providerConfig.findProviderInstance(tenantId, disabled.id)).toMatchObject({
      enabled: false,
      revision: 2,
    });

    const audits = await queryRows(
      orm,
      `select operation from audit_events where tenant_id = ? order by occurred_at, operation`,
      [tenantId],
    );
    expect(audits.map((a) => a.operation).sort()).toEqual([
      'provider_instance.created',
      'provider_instance.created',
      'provider_instance.updated',
      'tenant.created',
    ]);
  });

  it('publishes routing policy versions only when the policy changes', async () => {
    const { tenantId, smtpId, resendId } = await configuredTenant();
    const policy = {
      routingKey: 'transactional',
      channel: 'email' as const,
      platform: null,
      enabled: true,
      maxAttempts: 5,
      ttlSeconds: 86_400,
      fallbackEnabled: true,
      providerNames: ['resend-main', 'smtp-main'],
    };

    const v1 = await repos.adminConfig.publishRoutingPolicy('operator', tenantId, policy);
    const same = await repos.adminConfig.publishRoutingPolicy('operator', tenantId, policy);
    const v2 = await repos.adminConfig.publishRoutingPolicy('operator', tenantId, {
      ...policy,
      providerNames: ['smtp-main'],
    });

    expect(v1).toMatchObject({ version: 1, changed: true });
    expect(same).toEqual({ ...v1, changed: false });
    expect(v2).toMatchObject({ version: 2, changed: true });

    const resolved = await repos.providerConfig.resolveRoutingPolicy(
      tenantId,
      'transactional',
      'email',
      null,
    );
    expect(resolved).toMatchObject({ id: v2.id, version: 2, maxAttempts: 5 });
    expect(resolved?.providers.map((p) => p.id)).toEqual([smtpId]);
    expect(resendId).not.toBe(smtpId);
    expect(
      await repos.providerConfig.resolveRoutingPolicy(tenantId, 'marketing', 'email', null),
    ).toBeNull();
  });

  it('persists per-instance limits, reads them back and bumps the revision on change', async () => {
    const { tenantId, smtpId } = await configuredTenant();
    expect((await repos.providerConfig.findProviderInstance(tenantId, smtpId))?.limits).toEqual({});

    const base = {
      name: 'smtp-main',
      providerType: 'smtp',
      channel: 'email' as const,
      platform: null,
      config: { host: 'mailpit', port: 1025 },
      secretRef: 'smtp-main',
      enabled: true,
    };
    const limits = {
      sendRateLimit: { burst: 4, perSecond: 0.5 },
      circuitBreaker: { failureThreshold: 2, openMs: 10_000 },
    };
    const changed = await repos.adminConfig.upsertProviderInstance('operator', tenantId, {
      ...base,
      limits,
    });
    expect(changed).toEqual({ id: smtpId, changed: true });
    expect(await repos.providerConfig.findProviderInstance(tenantId, smtpId)).toMatchObject({
      limits,
      revision: 2,
    });
    const same = await repos.adminConfig.upsertProviderInstance('operator', tenantId, {
      ...base,
      limits,
    });
    expect(same.changed).toBe(false);

    // Malformed stored values (manual edits) fall back to the defaults instead of failing.
    await queryRows(orm, `update provider_instances set limits = ?::jsonb where id = ?`, [
      JSON.stringify({ sendRateLimit: { burst: 'x' }, circuitBreaker: { openMs: -1 } }),
      smtpId,
    ]);
    expect((await repos.providerConfig.findProviderInstance(tenantId, smtpId))?.limits).toEqual({});
  });

  it('refuses to route to a provider instance of another tenant', async () => {
    const a = await configuredTenant();
    const b = await configuredTenant();
    await repos.adminConfig.upsertProviderInstance('operator', b.tenantId, {
      name: 'only-in-b',
      providerType: 'smtp',
      channel: 'email',
      platform: null,
      config: {},
      secretRef: null,
      enabled: true,
      limits: {},
    });

    await expect(
      repos.adminConfig.publishRoutingPolicy('operator', a.tenantId, {
        routingKey: 'transactional',
        channel: 'email',
        platform: null,
        enabled: true,
        maxAttempts: 5,
        ttlSeconds: 60,
        fallbackEnabled: false,
        providerNames: ['only-in-b'],
      }),
    ).rejects.toThrow(/Unknown provider instance/);
    expect(await repos.providerConfig.findProviderInstance(a.tenantId, b.smtpId)).toBeNull();
  });

  it('looks up API keys by prefix with tenant status and scopes', async () => {
    const { tenantId } = await configuredTenant();
    const prefix = `ns_${randomUUID().slice(0, 8)}`;
    await repos.adminConfig.upsertApiKey('operator', tenantId, {
      name: 'backend',
      keyPrefix: prefix,
      keyHash: 'sha256:abc',
      scopes: ['notifications:write', 'notifications:read'],
      expiresAt: null,
      revoked: false,
    });

    const found = await repos.apiKeys.findByPrefix(prefix);
    expect(found).toMatchObject({
      tenantId,
      keyHash: 'sha256:abc',
      scopes: ['notifications:write', 'notifications:read'],
      revokedAt: null,
      tenantActive: true,
    });
    await repos.apiKeys.touchLastUsed(found?.id ?? '', new Date());

    await repos.adminConfig.upsertApiKey('operator', tenantId, {
      name: 'backend',
      keyPrefix: prefix,
      keyHash: 'sha256:abc',
      scopes: ['notifications:write', 'notifications:read'],
      expiresAt: null,
      revoked: true,
    });
    expect((await repos.apiKeys.findByPrefix(prefix))?.revokedAt).toBeInstanceOf(Date);
    expect(await repos.apiKeys.findByPrefix('missing')).toBeNull();
  });

  it('stores provider events once, correlating early events once the reference is known', async () => {
    const fixture = await createTenantFixture(orm);
    const created = await repos.notifications.create(notificationInput(fixture));
    if (created.kind !== 'created') throw new Error('expected created');
    const deliveryId = await deliveryIdOf(orm, created.notificationId);

    const event: ProviderEventInput = {
      tenantId: fixture.tenantId,
      providerInstanceId: fixture.providerInstanceId,
      externalEventId: 'evt-1',
      externalMessageId: 'msg-42',
      type: 'delivered',
      occurredAt: new Date(),
      receivedAt: new Date(),
      payload: { status: 'delivered' },
    };
    // Webhook arrives before the attempt recorded its external reference.
    const first = await repos.providerEvents.record(event);
    const duplicate = await repos.providerEvents.record(event);
    expect(first.kind).toBe('inserted');
    expect(first.event.deliveryId).toBeNull();
    expect(duplicate).toMatchObject({ kind: 'duplicate', event: { id: first.event.id } });

    const claim = await repos.deliveries.claim(deliveryId, 1, 60_000);
    if (!claim) throw new Error('expected claim');
    const attemptId = randomUUID();
    await repos.deliveries.startAttempt(claim, {
      attemptId,
      attemptNumber: 1,
      providerInstanceId: fixture.providerInstanceId,
      providerInstanceRevision: 1,
      providerIdempotencyKey: 'k1',
    });
    await repos.deliveries.resolveAttempt(claim, attemptId, {
      outcome: 'accepted',
      externalReference: 'msg-42',
      receiptStatus: 'pending',
    });

    expect(await repos.providerEvents.correlatePending(100)).toBeGreaterThanOrEqual(1);
    const late = await repos.providerEvents.record({
      ...event,
      externalEventId: 'evt-2',
      receivedAt: new Date(event.receivedAt.getTime() + 1000),
    });
    expect(late.event.deliveryId).toBe(deliveryId);

    const unprocessed = await repos.providerEvents.findUnprocessedCorrelated(1000);
    const mine = unprocessed.filter((e) => e.tenantId === fixture.tenantId);
    expect(mine.map((e) => [e.externalEventId, e.deliveryId])).toEqual([
      ['evt-1', deliveryId],
      ['evt-2', deliveryId],
    ]);
    expect(
      await repos.providerEvents.markProcessed(fixture.tenantId, first.event.id, new Date()),
    ).toBe(true);
    expect(
      await repos.providerEvents.markProcessed(fixture.tenantId, first.event.id, new Date()),
    ).toBe(false);

    // Receipt compare-and-set: delivered is not degraded by a late, lower-precedence update.
    expect(
      await repos.receipts.updateReceiptStatus(
        fixture.tenantId,
        deliveryId,
        ['pending'],
        'delivered',
      ),
    ).toBe(true);
    expect(
      await repos.receipts.updateReceiptStatus(
        fixture.tenantId,
        deliveryId,
        ['pending'],
        'pending',
      ),
    ).toBe(false);
    const other = await createTenantFixture(orm);
    expect(
      await repos.receipts.updateReceiptStatus(
        other.tenantId,
        deliveryId,
        ['delivered'],
        'undeliverable',
      ),
    ).toBe(false);
  });

  it('keeps suppressions per tenant and idempotent', async () => {
    const a = await createTenantFixture(orm);
    const b = await createTenantFixture(orm);
    const input = {
      tenantId: a.tenantId,
      channel: 'email' as const,
      recipientKey: 'User@Example.test',
      reason: 'hard_bounce' as const,
      source: 'provider_event' as const,
      providerEventId: null,
    };

    expect(await repos.suppressions.add(input)).toBe(true);
    expect(await repos.suppressions.add(input)).toBe(false);
    expect(await repos.suppressions.isSuppressed(a.tenantId, 'email', 'User@Example.test')).toBe(
      true,
    );
    expect(await repos.suppressions.isSuppressed(b.tenantId, 'email', 'User@Example.test')).toBe(
      false,
    );
  });

  it('records audit events without requiring a tenant', async () => {
    await repos.audit.record({
      tenantId: null,
      actor: 'operator',
      operation: 'config.applied',
      resourceType: 'config',
      resourceId: null,
      details: { file: 'local.example.json' },
    });
    const rows = await queryRows(
      orm,
      `select count(*)::int as n from audit_events where operation = 'config.applied'`,
    );
    expect(rows[0]?.n).toBeGreaterThanOrEqual(1);
  });
});
