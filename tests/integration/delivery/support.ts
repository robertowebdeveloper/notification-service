import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { PgDeliveryControlRepository } from '../../../src/infrastructure/database/delivery-control-repository.js';
import {
  silentLogger,
  type BreakerPermit,
  type ProviderCircuitBreaker,
  type ProviderRateLimiter,
  type RateLimitDecision,
} from '../../../src/application/delivery/ports.js';
import {
  ProcessDelivery,
  type ProcessDeliveryDeps,
} from '../../../src/application/delivery/process-delivery.js';
import type { PayloadByChannel } from '../../../src/contracts/channels.js';
import type {
  ConfigValidationResult,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderStatusResult,
  SendContext,
  SendResult,
} from '../../../src/contracts/provider-port.js';
import {
  createRepositories,
  type Repositories,
} from '../../../src/infrastructure/database/repositories.js';
import { ProviderRegistry } from '../../../src/infrastructure/providers/registry.js';
import { queryRows } from '../database/support.js';

export const SMTP_LIKE: ProviderCapabilities = {
  channels: ['email'],
  platforms: [],
  formats: ['text', 'html'],
  idempotency: { supported: false },
  receipts: false,
  statusQuery: false,
};

export const IDEMPOTENT_WITH_RECEIPTS: ProviderCapabilities = {
  channels: ['email'],
  platforms: [],
  formats: ['text', 'html'],
  idempotency: { supported: true, windowSeconds: 24 * 3600 },
  receipts: true,
  statusQuery: true,
};

export interface RecordedSend {
  deliveryId: string;
  attemptId: string;
  idempotencyKey: string;
  instanceId: string;
  recipient: string;
}

type Behaviour = (context: SendContext, call: number) => Promise<SendResult>;

export const accept: Behaviour = () =>
  Promise.resolve({ outcome: 'accepted', externalReference: `ext-${randomUUID()}` });

/** Programmable adapter: never talks to a real provider. */
export class FakeEmailAdapter implements ProviderAdapter<'email', Record<string, unknown>> {
  readonly requiredSecrets: readonly string[] = [];
  readonly sends: RecordedSend[] = [];
  private behaviours: Behaviour[] = [];
  statusResult: ((reference: string) => Promise<ProviderStatusResult>) | undefined;
  getStatus?: NonNullable<ProviderAdapter<'email', Record<string, unknown>>['getStatus']>;

  constructor(
    readonly providerType: string,
    readonly capabilities: ProviderCapabilities = SMTP_LIKE,
    private readonly fallbackBehaviour: Behaviour = accept,
  ) {
    if (capabilities.statusQuery) {
      this.getStatus = (reference: string) =>
        this.statusResult ? this.statusResult(reference) : Promise.resolve({ found: false });
    }
  }

  /** Queue behaviours for the next calls; afterwards the fallback behaviour applies. */
  queue(...behaviours: Behaviour[]): this {
    this.behaviours.push(...behaviours);
    return this;
  }

  validateConfig(config: unknown): ConfigValidationResult<Record<string, unknown>> {
    return { ok: true, config: (config ?? {}) as Record<string, unknown> };
  }

  async send(
    payload: PayloadByChannel['email'],
    context: SendContext<Record<string, unknown>>,
  ): Promise<SendResult> {
    this.sends.push({
      deliveryId: context.deliveryId,
      attemptId: context.attemptId,
      idempotencyKey: context.idempotencyKey,
      instanceId: context.instance.id,
      recipient: payload.recipient.email,
    });
    const behaviour = this.behaviours.shift() ?? this.fallbackBehaviour;
    return behaviour(context, this.sends.length);
  }
}

export function reject(
  kind: 'retryable' | 'permanent' | 'configuration',
  extra: { retryAfterMs?: number; code?: string } = {},
): Behaviour {
  return () =>
    Promise.resolve({
      outcome: 'rejected',
      error: {
        kind,
        code: extra.code ?? `${kind}_error`,
        message: `${kind} rejection`,
        definitelyNotAccepted: true,
        ...(extra.retryAfterMs !== undefined ? { retryAfterMs: extra.retryAfterMs } : {}),
      },
    });
}

export function unknownResult(externalReference?: string): Behaviour {
  return () =>
    Promise.resolve(
      externalReference === undefined
        ? { outcome: 'unknown', reason: 'timeout_after_submission' }
        : { outcome: 'unknown', reason: 'timeout_after_submission', externalReference },
    );
}

/** Hangs until the AbortSignal fires, then reports an ambiguous result (timeout after DATA). */
export const hangUntilAborted: Behaviour = (context) =>
  new Promise((resolve) => {
    context.signal.addEventListener('abort', () => {
      resolve({ outcome: 'unknown', reason: 'aborted_after_submission' });
    });
  });

/** Blocks until `release` is called with the result. */
export function gate(): {
  behaviour: Behaviour;
  release: (result: SendResult) => void;
  started: Promise<void>;
} {
  let release: (result: SendResult) => void = () => undefined;
  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const result = new Promise<SendResult>((resolve) => {
    release = resolve;
  });
  return {
    behaviour: () => {
      markStarted();
      return result;
    },
    release: (value) => {
      release(value);
    },
    started,
  };
}

export class AllowAllLimiter implements ProviderRateLimiter {
  calls = 0;
  tryAcquire(): Promise<RateLimitDecision> {
    this.calls += 1;
    return Promise.resolve({ allowed: true });
  }
}

export class InMemoryBreaker implements ProviderCircuitBreaker {
  readonly open = new Map<string, number>();
  readonly failures = new Map<string, number>();
  readonly forced: { id: string; durationMs: number }[] = [];
  readonly successes: { id: string; probeToken: string | undefined }[] = [];
  readonly released: { id: string; probeToken: string }[] = [];
  /** When set, the next acquire grants the half-open probe with this token. */
  probeToken: string | undefined;
  acquire(id: string): Promise<BreakerPermit> {
    const until = this.open.get(id);
    if (until !== undefined && until > Date.now()) {
      return Promise.resolve({ allowed: false, retryAfterMs: until - Date.now() });
    }
    const probeToken = this.probeToken;
    this.probeToken = undefined;
    return Promise.resolve(
      probeToken === undefined
        ? { allowed: true, probe: false }
        : { allowed: true, probe: true, probeToken },
    );
  }
  recordSuccess(id: string, probeToken?: string): Promise<void> {
    this.successes.push({ id, probeToken });
    return Promise.resolve();
  }
  releaseProbe(id: string, probeToken: string): Promise<void> {
    this.released.push({ id, probeToken });
    return Promise.resolve();
  }
  recordFailure(id: string): Promise<void> {
    this.failures.set(id, (this.failures.get(id) ?? 0) + 1);
    return Promise.resolve();
  }
  forceOpen(id: string, durationMs: number): Promise<void> {
    this.forced.push({ id, durationMs });
    this.open.set(id, Date.now() + durationMs);
    return Promise.resolve();
  }
}

export interface DeliveryFixture {
  tenantId: string;
  policyId: string;
  instanceIds: string[];
}

export interface FixtureProvider {
  type: string;
  enabled?: boolean;
}

export async function createDeliveryFixture(
  orm: MikroORM,
  providers: FixtureProvider[],
): Promise<DeliveryFixture> {
  const tenantId = randomUUID();
  const policyId = randomUUID();
  const instanceIds = providers.map(() => randomUUID());
  await orm.em.fork().transactional(async (tx) => {
    await tx.execute(`insert into tenants (id, slug, name) values (?, ?, 'Delivery tests')`, [
      tenantId,
      `tenant-${tenantId}`,
    ]);
    for (const [index, provider] of providers.entries()) {
      await tx.execute(
        `insert into provider_instances (id, tenant_id, name, provider_type, channel, config, enabled)
         values (?, ?, ?, ?, 'email', '{}'::jsonb, ?)`,
        [
          instanceIds[index],
          tenantId,
          `provider-${index}`,
          provider.type,
          provider.enabled ?? true,
        ],
      );
    }
    await tx.execute(
      `insert into routing_policies (id, tenant_id, routing_key, channel, version, max_attempts)
       values (?, ?, 'transactional', 'email', 1, 5)`,
      [policyId, tenantId],
    );
    for (const [index, id] of instanceIds.entries()) {
      await tx.execute(
        `insert into routing_policy_providers (routing_policy_id, position, tenant_id, provider_instance_id)
         values (?, ?, ?, ?)`,
        [policyId, index, tenantId, id],
      );
    }
  });
  return { tenantId, policyId, instanceIds };
}

export interface NewDeliveryOptions {
  email?: string;
  maxAttempts?: number;
  expiresAt?: Date;
  instanceIds?: string[];
  fallbackEnabled?: boolean;
}

export async function createDelivery(
  repos: Repositories,
  orm: MikroORM,
  fixture: DeliveryFixture,
  options: NewDeliveryOptions = {},
): Promise<string> {
  const routing = {
    policyId: fixture.policyId,
    policyVersion: 1,
    platform: null,
    providerInstanceIds: options.instanceIds ?? fixture.instanceIds,
    maxAttempts: options.maxAttempts ?? 5,
    fallbackEnabled: options.fallbackEnabled ?? true,
  };
  const result = await repos.notifications.create({
    tenantId: fixture.tenantId,
    idempotencyKey: `key-${randomUUID()}`,
    requestHash: 'hash',
    routingKey: 'transactional',
    payload: {
      channel: 'email',
      recipient: { email: options.email ?? 'recipient@example.test' },
      content: { from: 'sender@example.test', subject: 'Hello', text: 'Body' },
    },
    metadata: {},
    routing,
    expiresAt: options.expiresAt ?? new Date(Date.now() + 24 * 3600_000),
  });
  if (result.kind !== 'created') throw new Error('expected created notification');
  const rows = await queryRows(orm, `select id from deliveries where notification_id = ?`, [
    result.notificationId,
  ]);
  const id = rows[0]?.id;
  if (typeof id !== 'string') throw new Error('delivery not found');
  return id;
}

export interface DeliveryRow {
  submission_status: string;
  receipt_status: string;
  generation: number;
  attempts_used: number;
  version: number;
  lease_token: string | null;
  next_attempt_at: string | null;
  terminal_reason: string | null;
  last_error_code: string | null;
}

export async function deliveryRow(orm: MikroORM, id: string): Promise<DeliveryRow> {
  const rows = await queryRows(
    orm,
    `select submission_status, receipt_status, generation, attempts_used, version, lease_token,
            next_attempt_at, terminal_reason, last_error_code
     from deliveries where id = ?`,
    [id],
  );
  if (!rows[0]) throw new Error('delivery not found');
  return rows[0] as unknown as DeliveryRow;
}

export async function attemptRows(orm: MikroORM, deliveryId: string) {
  return queryRows(
    orm,
    `select attempt_number, generation, provider_instance_id, provider_idempotency_key, outcome,
            error_kind, error_code, external_reference
     from delivery_attempts where delivery_id = ? order by attempt_number`,
    [deliveryId],
  );
}

export async function outboxRows(orm: MikroORM, deliveryId: string) {
  return queryRows(
    orm,
    `select id, generation, status, available_at, dispatch_count, last_error
     from outbox_events where delivery_id = ? order by generation`,
    [deliveryId],
  );
}

export function toTime(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== 'string') throw new TypeError('expected timestamp');
  let iso = value.replace(' ', 'T');
  if (/[+-]\d{2}$/.test(iso)) iso += ':00';
  return new Date(iso).getTime();
}

export interface Harness {
  repos: Repositories;
  control: PgDeliveryControlRepository;
  registry: ProviderRegistry;
}

export function harness(orm: MikroORM, adapters: FakeEmailAdapter[]): Harness {
  return {
    repos: createRepositories(orm),
    control: new PgDeliveryControlRepository(orm),
    registry: new ProviderRegistry(adapters),
  };
}

export function processDelivery(
  h: Harness,
  overrides: Partial<ProcessDeliveryDeps> = {},
): ProcessDelivery {
  return new ProcessDelivery({
    deliveries: h.repos.deliveries,
    control: h.control,
    providerConfig: h.repos.providerConfig,
    suppressions: h.repos.suppressions,
    catalog: h.registry,
    secrets: { resolve: () => Promise.resolve(new Map()) },
    rateLimiter: new AllowAllLimiter(),
    breaker: new InMemoryBreaker(),
    logger: silentLogger,
    random: () => 0,
    ...overrides,
    options: {
      leaseMs: 60_000,
      sendTimeoutMs: 5_000,
      retryPolicy: { baseDelayMs: 5_000, maxDelayMs: 300_000, jitterRatio: 0.5 },
      ...overrides.options,
    },
  });
}

/**
 * Simulates time passing until the next attempt of a delivery is due (database clock): leases,
 * availability and `next_attempt_at` are compared with PostgreSQL `now()`, never an app clock.
 */
export async function makeDue(orm: MikroORM, deliveryId: string): Promise<void> {
  await queryRows(
    orm,
    `update deliveries set next_attempt_at = now() where id = ? and next_attempt_at > now()`,
    [deliveryId],
  );
  await queryRows(
    orm,
    `update outbox_events set available_at = now()
     where delivery_id = ? and status <> 'published' and available_at > now()`,
    [deliveryId],
  );
}

/** Expires the worker lease of a delivery on the database clock. */
export async function expireLease(orm: MikroORM, deliveryId: string): Promise<void> {
  await queryRows(
    orm,
    `update deliveries set lease_expires_at = now() - interval '1 second'
     where id = ? and lease_token is not null`,
    [deliveryId],
  );
}

/** Job of the newest outbox event, once the delivery is due (see `makeDue`). */
export async function dueJob(orm: MikroORM, deliveryId: string) {
  await makeDue(orm, deliveryId);
  return latestJob(orm, deliveryId);
}

/** Job data of the newest outbox event of a delivery. */
export async function latestJob(orm: MikroORM, deliveryId: string) {
  const rows = await outboxRows(orm, deliveryId);
  const row = rows.at(-1);
  if (!row) throw new Error('no outbox event');
  return { deliveryId, generation: Number(row.generation), outboxEventId: String(row.id) };
}

export async function waitFor<T>(
  probe: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 10_000,
  intervalMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`condition not met in ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
