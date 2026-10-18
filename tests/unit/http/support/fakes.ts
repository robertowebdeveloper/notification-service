import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import type { FastifyInstance } from 'fastify';
import type {
  ApiKeyRecord,
  ApiKeyRepository,
  ProviderConfigRepository,
  ProviderEventInput,
  ProviderEventRepository,
  ProviderInstanceRecord,
  RecordProviderEventResult,
  RoutingPolicyRecord,
  StoredProviderEvent,
} from '../../../../src/application/ports/lookup-repositories.js';
import { InvalidCursorError } from '../../../../src/application/ports/lookup-repositories.js';
import type {
  CreateNotificationInput,
  CreateNotificationResult,
  ManualRetryInput,
  ManualRetryRepository,
  ManualRetryResult,
  NotificationDetail,
  NotificationRepository,
  NotificationSummary,
} from '../../../../src/application/ports/repositories.js';
import type {
  RateLimitDecision,
  RateLimiter,
  SenderPolicyRepository,
} from '../../../../src/application/notifications/ports.js';
import { BacklogGuard } from '../../../../src/application/notifications/ingress-guards.js';
import type { Channel } from '../../../../src/contracts/channels.js';
import type { ApiScope } from '../../../../src/contracts/statuses.js';
import { createApiDependencies } from '../../../../src/http/api-dependencies.js';
import { buildApp } from '../../../../src/http/app.js';
import { RecordingMetrics } from '../../observability/recording-metrics.js';
import { createEmailProviderRegistry } from '../../../../src/infrastructure/providers/registry.js';
import { generateApiKey } from '../../../../src/infrastructure/security/api-keys.js';
import { createSecretResolver } from '../../../../src/infrastructure/security/secret-resolver.js';

export class FakeApiKeys implements ApiKeyRepository {
  readonly records = new Map<string, ApiKeyRecord>();
  touched: string[] = [];

  add(tenantId: string, scopes: ApiScope[], overrides: Partial<ApiKeyRecord> = {}): string {
    const key = generateApiKey();
    this.records.set(key.keyPrefix, {
      id: randomUUID(),
      tenantId,
      keyHash: key.keyHash,
      scopes,
      expiresAt: null,
      revokedAt: null,
      tenantActive: true,
      ...overrides,
    });
    return key.plaintext;
  }

  findByPrefix(keyPrefix: string): Promise<ApiKeyRecord | null> {
    return Promise.resolve(this.records.get(keyPrefix) ?? null);
  }

  touchLastUsed(apiKeyId: string): Promise<void> {
    this.touched.push(apiKeyId);
    return Promise.resolve();
  }
}

interface StoredNotification {
  input: CreateNotificationInput;
  detail: NotificationDetail;
}

export class FakeNotifications implements NotificationRepository {
  readonly byId = new Map<string, StoredNotification>();
  pendingOutbox = 0;
  createCalls = 0;

  create(input: CreateNotificationInput): Promise<CreateNotificationResult> {
    this.createCalls += 1;
    for (const [id, stored] of this.byId) {
      if (
        stored.input.tenantId === input.tenantId &&
        stored.input.idempotencyKey === input.idempotencyKey
      ) {
        return Promise.resolve(
          stored.input.requestHash === input.requestHash
            ? { kind: 'replayed', notificationId: id }
            : { kind: 'conflict' },
        );
      }
    }
    const id = randomUUID();
    const now = new Date();
    this.byId.set(id, {
      input,
      detail: {
        id,
        channel: input.payload.channel,
        platform: input.routing.platform,
        routingKey: input.routingKey,
        submissionStatus: 'pending',
        receiptStatus: 'unavailable',
        createdAt: now,
        updatedAt: now,
        attempts: [],
        lastError: null,
      },
    });
    return Promise.resolve({ kind: 'created', notificationId: id });
  }

  findByIdempotencyKey(
    tenantId: string,
    idempotencyKey: string,
  ): Promise<{ notificationId: string; requestHash: string } | null> {
    for (const [id, stored] of this.byId) {
      if (stored.input.tenantId === tenantId && stored.input.idempotencyKey === idempotencyKey) {
        return Promise.resolve({ notificationId: id, requestHash: stored.input.requestHash });
      }
    }
    return Promise.resolve(null);
  }

  findById(tenantId: string, id: string): Promise<NotificationDetail | null> {
    const stored = this.byId.get(id);
    return Promise.resolve(stored?.input.tenantId === tenantId ? stored.detail : null);
  }

  list(
    tenantId: string,
    filter: { limit: number; cursor?: string; channel?: Channel },
  ): Promise<{ items: NotificationSummary[]; nextCursor: string | null }> {
    if (filter.cursor !== undefined && filter.cursor !== 'valid') {
      return Promise.reject(new InvalidCursorError());
    }
    const items = [...this.byId.values()]
      .filter((s) => s.input.tenantId === tenantId)
      .map((s) => s.detail)
      .slice(0, filter.limit);
    return Promise.resolve({ items, nextCursor: null });
  }

  countPendingOutbox(): Promise<number> {
    return Promise.resolve(this.pendingOutbox);
  }
}

export function instance(
  tenantId: string,
  overrides: Partial<ProviderInstanceRecord> = {},
): ProviderInstanceRecord {
  return {
    id: randomUUID(),
    tenantId,
    name: 'smtp-main',
    providerType: 'smtp',
    channel: 'email',
    platform: null,
    config: { host: 'localhost', port: 1025, tlsRequired: false, profile: 'local' },
    secretRef: null,
    enabled: true,
    revision: 1,
    limits: {},
    ...overrides,
  };
}

export class FakeProviderConfig implements ProviderConfigRepository {
  readonly policies = new Map<string, RoutingPolicyRecord>();
  readonly instances: ProviderInstanceRecord[] = [];

  addPolicy(
    tenantId: string,
    providers: ProviderInstanceRecord[],
    overrides: Partial<RoutingPolicyRecord> = {},
  ) {
    const policy: RoutingPolicyRecord = {
      id: randomUUID(),
      tenantId,
      routingKey: 'transactional',
      channel: 'email',
      platform: null,
      version: 1,
      enabled: true,
      maxAttempts: 4,
      ttlSeconds: 3600,
      fallbackEnabled: true,
      providers,
      ...overrides,
    };
    this.policies.set(`${tenantId}|${policy.routingKey}|${policy.channel}`, policy);
    this.instances.push(...providers);
    return policy;
  }

  findProviderInstance(tenantId: string, id: string): Promise<ProviderInstanceRecord | null> {
    return Promise.resolve(
      this.instances.find((i) => i.tenantId === tenantId && i.id === id) ?? null,
    );
  }

  findProviderInstanceForWebhook(
    providerType: string,
    instanceId: string,
  ): Promise<ProviderInstanceRecord | null> {
    return Promise.resolve(
      this.instances.find((i) => i.providerType === providerType && i.id === instanceId) ?? null,
    );
  }

  readonly resolveCalls: { routingKey: string; channel: Channel; platform: string | null }[] = [];

  resolveRoutingPolicy(
    tenantId: string,
    routingKey: string,
    channel: Channel,
    platform: string | null,
  ): Promise<RoutingPolicyRecord | null> {
    this.resolveCalls.push({ routingKey, channel, platform });
    return Promise.resolve(this.policies.get(`${tenantId}|${routingKey}|${channel}`) ?? null);
  }
}

export class FakeProviderEvents implements Pick<ProviderEventRepository, 'record'> {
  readonly events: StoredProviderEvent[] = [];

  record(input: ProviderEventInput): Promise<RecordProviderEventResult> {
    const existing = this.events.find(
      (e) =>
        e.providerInstanceId === input.providerInstanceId &&
        e.externalEventId === input.externalEventId,
    );
    if (existing) return Promise.resolve({ kind: 'duplicate', event: existing });
    const event: StoredProviderEvent = {
      id: randomUUID(),
      tenantId: input.tenantId,
      providerInstanceId: input.providerInstanceId,
      externalEventId: input.externalEventId,
      externalMessageId: input.externalMessageId,
      type: input.type,
      occurredAt: input.occurredAt,
      receivedAt: input.receivedAt,
      deliveryId: null,
      processedAt: null,
    };
    this.events.push(event);
    return Promise.resolve({ kind: 'inserted', event });
  }
}

export class FakeManualRetries implements ManualRetryRepository {
  calls: ManualRetryInput[] = [];
  next: ManualRetryResult = { kind: 'scheduled', generation: 2 };

  retryFailed(input: ManualRetryInput): Promise<ManualRetryResult> {
    this.calls.push(input);
    return Promise.resolve(this.next);
  }
}

export class FakeSenderPolicy implements SenderPolicyRepository {
  allowed = ['@example.test'];
  allowedSenders(): Promise<readonly string[]> {
    return Promise.resolve(this.allowed);
  }
}

export class FakeRateLimiter implements RateLimiter {
  decision: RateLimitDecision = { allowed: true, retryAfterMs: 0 };
  fail = false;
  keys: string[] = [];
  consume(key: string): Promise<RateLimitDecision> {
    this.keys.push(key);
    if (this.fail) return Promise.reject(new Error('valkey down'));
    return Promise.resolve(this.decision);
  }
}

export const WEBHOOK_SECRET = 'whsec_' + Buffer.from('unit-test-webhook-secret').toString('base64');

export interface TestApi {
  app: FastifyInstance;
  apiKeys: FakeApiKeys;
  notifications: FakeNotifications;
  providerConfig: FakeProviderConfig;
  providerEvents: FakeProviderEvents;
  manualRetries: FakeManualRetries;
  senderPolicy: FakeSenderPolicy;
  rateLimiter: FakeRateLimiter;
  metrics: RecordingMetrics;
}

export async function buildTestApi(backlogLimit = 100): Promise<TestApi> {
  const apiKeys = new FakeApiKeys();
  const notifications = new FakeNotifications();
  const providerConfig = new FakeProviderConfig();
  const providerEvents = new FakeProviderEvents();
  const manualRetries = new FakeManualRetries();
  const senderPolicy = new FakeSenderPolicy();
  const rateLimiter = new FakeRateLimiter();
  const metrics = new RecordingMetrics();
  const app = await buildApp({
    logger: false,
    readiness: () => Promise.resolve({ ready: true, checks: {} }),
    api: createApiDependencies({
      notifications,
      manualRetries,
      apiKeys,
      providerConfig,
      providerEvents,
      senderPolicy,
      registry: createEmailProviderRegistry(),
      secrets: createSecretResolver({
        env: { RESEND_TEST_API_KEY: 're_test', RESEND_TEST_WEBHOOK_SECRET: WEBHOOK_SECRET },
      }),
      rateLimiter,
      backlog: new BacklogGuard(() => notifications.countPendingOutbox(), backlogLimit, 0),
      logger: pino({ level: 'silent' }),
      ingressLimit: { limit: 100, windowMs: 1_000 },
      webhookLimit: { limit: 200, windowMs: 1_000 },
      metrics,
    }),
  });
  return {
    app,
    apiKeys,
    notifications,
    providerConfig,
    providerEvents,
    manualRetries,
    senderPolicy,
    rateLimiter,
    metrics,
  };
}

export function emailBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channel: 'email',
    routingKey: 'transactional',
    recipient: { email: 'customer@example.org' },
    content: { from: 'Orders <orders@example.test>', subject: 'Order 123', text: 'Received' },
    metadata: { orderId: '123' },
    ...overrides,
  };
}
