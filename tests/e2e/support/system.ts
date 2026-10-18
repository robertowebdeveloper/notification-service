import { randomUUID } from 'node:crypto';
import type { NotificationView } from '../../../src/contracts/http-schemas.js';
import type { SubmissionStatus } from '../../../src/contracts/statuses.js';
import { ApiClient } from './api-client.js';
import { E2eDatabase, type Row } from './database.js';
import { E2E_ENV, SERVICE_TUNING, TIMING, freePort, valkeyUrlFor } from './env.js';
import { startFakeResendServer, type FakeResendServer } from './fake-resend.js';
import { startFakeSmtpServer, type FakeSmtpServer } from './fake-smtp.js';
import { Mailpit } from './mailpit.js';
import {
  killAllServices,
  liveServices,
  runToCompletion,
  spawnService,
  waitForHttpReady,
  type ServiceProcess,
} from './processes.js';
import { E2eQueue } from './queue.js';
import {
  ALL_SCOPES,
  ConfigApplySeeder,
  type ProviderInstanceSpec,
  type RoutingPolicySpec,
  type SeededTenant,
  type TenantSeeder,
  type TenantSpec,
} from './seed.js';
import { generateWebhookSecret } from './webhooks.js';
import { waitFor } from './wait-for.js';

/** Startup log line of dispatcher and worker (pino `msg` ending with "started"). */
const STARTED = /"msg":"(?!shutdown)[^"]*started"/;

/** Secret reference used by every fake Resend instance (resolved from the service env). */
export const RESEND_SECRET_REF = 'env:E2E_RESEND';
export const RESEND_TEST_API_KEY = 're_e2e_test_key_not_a_real_secret';

export interface DeliveryRow extends Row {
  id: string;
  tenant_id: string;
  notification_id: string;
  submission_status: SubmissionStatus;
  receipt_status: string;
  generation: number;
  attempts_used: number;
  lease_token: string | null;
  version: number;
}

export interface AttemptRow extends Row {
  id: string;
  attempt_number: number;
  generation: number;
  provider_instance_id: string;
  provider_idempotency_key: string;
  outcome: string;
  started_at: Date;
  finished_at: Date | null;
  error_kind: string | null;
  error_code: string | null;
  external_reference: string | null;
}

export interface OutboxRow extends Row {
  id: string;
  delivery_id: string;
  generation: number;
  status: string;
  dispatch_count: number;
  lease_token: string | null;
}

export interface SystemOptions {
  /** Unique per scenario file: selects the database `notifications_e2e_<slot>` and Valkey DB. */
  slot: number;
}

/**
 * One isolated system under test per scenario file: its own PostgreSQL database (migrated with the
 * real `migrate` entrypoint), its own Valkey DB index, fake providers, and helpers to start/kill
 * the real api, dispatcher and worker processes.
 */
export class E2eSystem {
  readonly mailpit = new Mailpit();
  readonly webhookSecret = generateWebhookSecret();
  readonly databaseName: string;
  readonly valkeyUrl: string;
  apiPort = 0;
  private seeder: TenantSeeder | undefined;

  private constructor(
    readonly slot: number,
    readonly db: E2eDatabase,
    readonly queue: E2eQueue,
    readonly smtp: FakeSmtpServer,
    readonly resend: FakeResendServer,
  ) {
    this.databaseName = db.name;
    this.valkeyUrl = queue.url;
  }

  static async create(options: SystemOptions): Promise<E2eSystem> {
    if (options.slot < 2 || options.slot > 15) throw new Error('slot must be in 2..15');
    const db = await E2eDatabase.open(`notifications_e2e_${String(options.slot)}`);
    const queue = new E2eQueue(valkeyUrlFor(options.slot));
    const [smtp, resend] = await Promise.all([startFakeSmtpServer(), startFakeResendServer()]);
    const system = new E2eSystem(options.slot, db, queue, smtp, resend);
    await system.resetState();
    return system;
  }

  /** Empty database + migrations through the real entrypoint, empty Valkey DB. */
  async resetState(): Promise<void> {
    await this.db.reset();
    await this.queue.flush();
    const run = await runToCompletion('migrate', {
      name: `migrate-${String(this.slot)}`,
      env: this.env(),
    });
    if (run.exit.code !== 0) {
      throw new Error(
        `migrate failed (${String(run.exit.code)})\n${run.lines.slice(-30).join('\n')}`,
      );
    }
  }

  /** Environment shared by every service process of this system. */
  env(extra: Record<string, string> = {}): Record<string, string> {
    return {
      APP_ENV: 'test',
      LOG_LEVEL: E2E_ENV.serviceLogLevel,
      HTTP_HOST: '127.0.0.1',
      HTTP_PORT: String(this.apiPort === 0 ? 3999 : this.apiPort),
      DATABASE_URL: this.db.url,
      DATABASE_SSL: 'false',
      DATABASE_POOL_MAX: '5',
      VALKEY_URL: this.valkeyUrl,
      SHUTDOWN_GRACE_MS: String(TIMING.shutdownGraceMs),
      // The migrator would otherwise write `.snapshot-<db>.json` into src/ for every e2e database.
      MIKRO_ORM_MIGRATIONS_SNAPSHOT_ON_MIGRATE: 'false',
      E2E_RESEND_API_KEY: RESEND_TEST_API_KEY,
      E2E_RESEND_WEBHOOK_SECRET: this.webhookSecret,
      OPS_HOST: '127.0.0.1',
      ...SERVICE_TUNING,
      ...extra,
    };
  }

  get apiUrl(): string {
    return `http://127.0.0.1:${String(this.apiPort)}`;
  }

  get api(): ApiClient {
    if (this.apiPort === 0) throw new Error('API not started');
    return new ApiClient(this.apiUrl);
  }

  // ------------------------------------------------------------------ processes

  async startApi(extraEnv: Record<string, string> = {}): Promise<ServiceProcess> {
    if (this.apiPort === 0) this.apiPort = await freePort();
    const api = spawnService('api', {
      name: `api-${String(this.slot)}`,
      env: this.env({ OPS_PORT: String(await freePort()), ...extraEnv }),
    });
    await waitForHttpReady(api, `${this.apiUrl}/health/ready`);
    return api;
  }

  async startDispatcher(
    name = 'dispatcher',
    extraEnv: Record<string, string> = {},
  ): Promise<ServiceProcess> {
    // Own HTTP port in case the role exposes health endpoints (several workers may run at once).
    const port = String(await freePort());
    const service = spawnService('dispatcher', {
      name: `${name}-${String(this.slot)}`,
      env: this.env({ HTTP_PORT: port, OPS_PORT: String(await freePort()), ...extraEnv }),
    });
    await service.waitForLine(STARTED);
    return service;
  }

  async startWorker(
    name = 'worker',
    extraEnv: Record<string, string> = {},
  ): Promise<ServiceProcess> {
    // Own HTTP port in case the role exposes health endpoints (several workers may run at once).
    const port = String(await freePort());
    const service = spawnService('worker', {
      name: `${name}-${String(this.slot)}`,
      env: this.env({ HTTP_PORT: port, OPS_PORT: String(await freePort()), ...extraEnv }),
    });
    await service.waitForLine(STARTED);
    return service;
  }

  /** api + dispatcher + one worker. */
  async startAll(): Promise<{
    api: ServiceProcess;
    dispatcher: ServiceProcess;
    worker: ServiceProcess;
  }> {
    const [api, dispatcher, worker] = await Promise.all([
      this.startApi(),
      this.startDispatcher(),
      this.startWorker(),
    ]);
    return { api, dispatcher, worker };
  }

  /** Log tails of every live service, appended to timeout errors. */
  diagnostics(): string {
    return liveServices()
      .map((service) => service.tail(40))
      .join('\n');
  }

  // ------------------------------------------------------------------ seeding

  useSeeder(seeder: TenantSeeder): void {
    this.seeder = seeder;
  }

  async seedTenant(
    spec: Partial<TenantSpec> & Pick<TenantSpec, 'providerInstances' | 'routingPolicies'>,
  ) {
    const slug = spec.slug ?? `e2e-${randomUUID().slice(0, 8)}`;
    this.seeder ??= new ConfigApplySeeder(this.db, () => this.env());
    return this.seeder.seed({
      slug,
      name: spec.name ?? `E2E tenant ${slug}`,
      apiKeys: spec.apiKeys ?? [{ name: 'e2e-primary', scopes: ALL_SCOPES }],
      providerInstances: spec.providerInstances,
      routingPolicies: spec.routingPolicies,
      ...(spec.allowedSenders === undefined ? {} : { allowedSenders: spec.allowedSenders }),
    });
  }

  // ------------------------------------------------------------------ provider instance specs

  mailpitInstance(name = 'mailpit'): ProviderInstanceSpec {
    return {
      name,
      providerType: 'smtp',
      channel: 'email',
      platform: null,
      config: {
        host: E2E_ENV.mailpitSmtpHost,
        port: E2E_ENV.mailpitSmtpPort,
        secure: false,
        requireTLS: false,
        tlsRequired: false,
        profile: 'local',
      },
      secretRef: null,
      enabled: true,
    };
  }

  fakeSmtpInstance(name = 'fake-smtp', config: Record<string, unknown> = {}): ProviderInstanceSpec {
    return {
      name,
      providerType: 'smtp',
      channel: 'email',
      platform: null,
      config: {
        host: this.smtp.host,
        port: this.smtp.port,
        secure: false,
        requireTLS: false,
        tlsRequired: false,
        profile: 'local',
        ...config,
      },
      secretRef: null,
      enabled: true,
    };
  }

  fakeResendInstance(
    name = 'fake-resend',
    config: Record<string, unknown> = {},
  ): ProviderInstanceSpec {
    return {
      name,
      providerType: 'resend',
      channel: 'email',
      platform: null,
      config: { baseUrl: this.resend.baseUrl, profile: 'local', ...config },
      secretRef: RESEND_SECRET_REF,
      enabled: true,
    };
  }

  policy(providers: string[], overrides: Partial<RoutingPolicySpec> = {}): RoutingPolicySpec {
    return {
      routingKey: 'transactional',
      channel: 'email',
      platform: null,
      enabled: true,
      maxAttempts: 5,
      ttlSeconds: 86_400,
      fallbackEnabled: true,
      providers,
      ...overrides,
    };
  }

  // ------------------------------------------------------------------ API helpers

  /** POSTs an email notification and asserts the 202 contract; returns the notification id. */
  async submit(tenant: SeededTenant, body: unknown, idempotencyKey = `e2e-${randomUUID()}`) {
    const response = await this.api.createNotification(tenant.apiKey, idempotencyKey, body);
    if (response.status !== 202) {
      throw new Error(
        `POST /v1/notifications answered ${String(response.status)}: ${JSON.stringify(response.body)}\n${this.diagnostics()}`,
      );
    }
    return response.body.id;
  }

  /** Polls GET /v1/notifications/:id until the submission status is one of `statuses`. */
  async waitForStatus(
    tenant: SeededTenant,
    id: string,
    statuses: readonly SubmissionStatus[],
    timeoutMs: number = TIMING.deliveryMs,
  ): Promise<NotificationView> {
    return waitFor(
      async () => {
        const response = await this.api.getNotification(tenant.apiKey, id);
        if (response.status !== 200) throw new Error(`GET answered ${String(response.status)}`);
        return statuses.includes(response.body.submissionStatus) ? response.body : undefined;
      },
      {
        timeoutMs,
        intervalMs: 300,
        description: `notification ${id} to reach ${statuses.join('|')}`,
        diagnostics: async () =>
          `DB state: ${JSON.stringify(await this.deliveryState(id))}\n${this.diagnostics()}`,
      },
    );
  }

  async view(tenant: SeededTenant, id: string): Promise<NotificationView> {
    const response = await this.api.getNotification(tenant.apiKey, id);
    if (response.status !== 200) throw new Error(`GET answered ${String(response.status)}`);
    return response.body;
  }

  // ------------------------------------------------------------------ DB inspection

  async delivery(notificationId: string): Promise<DeliveryRow | undefined> {
    return this.db.one<DeliveryRow>('select * from deliveries where notification_id = ?', [
      notificationId,
    ]);
  }

  async attempts(notificationId: string): Promise<AttemptRow[]> {
    return this.db.query<AttemptRow>(
      `select a.* from delivery_attempts a join deliveries d on d.id = a.delivery_id
       where d.notification_id = ? order by a.attempt_number`,
      [notificationId],
    );
  }

  async outbox(notificationId: string): Promise<OutboxRow[]> {
    return this.db.query<OutboxRow>(
      `select o.* from outbox_events o join deliveries d on d.id = o.delivery_id
       where d.notification_id = ? order by o.generation, o.created_at`,
      [notificationId],
    );
  }

  async deliveryState(notificationId: string) {
    const [delivery, attempts, outbox] = await Promise.all([
      this.delivery(notificationId),
      this.attempts(notificationId),
      this.outbox(notificationId),
    ]);
    return {
      delivery: delivery && {
        status: delivery.submission_status,
        receipt: delivery.receipt_status,
        generation: delivery.generation,
        attemptsUsed: delivery.attempts_used,
        leased: delivery.lease_token !== null,
      },
      attempts: attempts.map((a) => ({
        n: a.attempt_number,
        outcome: a.outcome,
        error: a.error_code,
      })),
      outbox: outbox.map((o) => ({
        gen: o.generation,
        status: o.status,
        dispatches: o.dispatch_count,
      })),
    };
  }

  // ------------------------------------------------------------------ teardown

  /** SIGKILLs all services and releases held provider responses (afterEach). */
  async stopServices(): Promise<void> {
    this.smtp.releaseAll();
    this.resend.releaseAll();
    await killAllServices();
  }

  async dispose(): Promise<void> {
    await this.stopServices();
    await Promise.allSettled([this.smtp.close(), this.resend.close(), this.queue.close()]);
    await this.db.close();
  }
}
