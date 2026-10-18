import { Type, type Static, type TSchema } from 'typebox';
import { Value } from 'typebox/value';

export const APP_ENVIRONMENTS = ['local', 'test', 'stage', 'production'] as const;
export type AppEnvironment = (typeof APP_ENVIRONMENTS)[number];

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Integer duration in milliseconds within [min, max]. */
const Ms = (minimum: number, maximum: number) => Type.Integer({ minimum, maximum });
const Count = (minimum: number, maximum: number) => Type.Integer({ minimum, maximum });

/** Hostname / IPv4 entry of PROVIDER_ALLOWED_HOSTS, optionally a `.suffix`. */
const HOST_ENTRY = '\\.?[A-Za-z0-9-]+(\\.[A-Za-z0-9-]+)*\\.?';
/** `true`, `false`, a hop count, or comma-separated proxy addresses/CIDRs. */
const TRUST_PROXY_PATTERN = '^(true|false|[0-9]{1,2}|[0-9A-Fa-f:./]+( *, *[0-9A-Fa-f:./]+)*)$';

const EnvSchema = Type.Object({
  /** Required, no default: a missing value must not silently disable stage/production checks. */
  APP_ENV: Type.Enum(APP_ENVIRONMENTS),
  LOG_LEVEL: Type.Enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
  HTTP_HOST: Type.String({ minLength: 1 }),
  HTTP_PORT: Type.Integer({ minimum: 1, maximum: 65535 }),
  /** Internal ops server (/metrics, worker/dispatcher health); never exposed via ingress. */
  OPS_HOST: Type.String({ minLength: 1 }),
  OPS_PORT: Type.Integer({ minimum: 1, maximum: 65535 }),
  DATABASE_URL: Type.String({ pattern: '^postgres(ql)?://' }),
  DATABASE_SSL: Type.Boolean(),
  DATABASE_POOL_MAX: Type.Integer({ minimum: 1, maximum: 200 }),
  /** TCP connect + startup, and waiting for a free pool client. */
  DATABASE_CONNECT_TIMEOUT_MS: Ms(SECOND, 2 * MINUTE),
  /** Server-side `statement_timeout` (the server cancels the statement). */
  DATABASE_STATEMENT_TIMEOUT_MS: Ms(SECOND, HOUR),
  /** Client-side read deadline for dead/blackholed connections; > statement timeout. */
  DATABASE_QUERY_TIMEOUT_MS: Ms(SECOND, HOUR),
  /** Server-side `idle_in_transaction_session_timeout`. */
  DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: Ms(SECOND, HOUR),
  /** Idle pool clients are closed after this long. */
  DATABASE_POOL_IDLE_TIMEOUT_MS: Ms(SECOND, 10 * MINUTE),
  /** TCP keepalive initial delay on pooled connections. */
  DATABASE_KEEPALIVE_INITIAL_DELAY_MS: Ms(SECOND, 10 * MINUTE),
  VALKEY_URL: Type.String({ pattern: '^rediss?://' }),
  SECRETS_DIR: Type.Optional(Type.String({ minLength: 1 })),
  OUTBOX_BACKLOG_LIMIT: Type.Integer({ minimum: 0 }),
  SHUTDOWN_GRACE_MS: Type.Integer({ minimum: 0 }),
  /**
   * Comma-separated destinations allowed for operator-configured provider endpoints (SMTP `host`,
   * Resend `baseUrl`): exact hostnames or `.suffix` (subdomains only). Unset = unrestricted.
   */
  PROVIDER_ALLOWED_HOSTS: Type.Optional(
    Type.String({ pattern: `^ *${HOST_ENTRY} *(, *${HOST_ENTRY} *)*$`, maxLength: 4096 }),
  ),

  // ------------------------------------------------------------------ HTTP server (API)
  /** Max time to receive a whole request (headers and body) from the client. */
  HTTP_REQUEST_TIMEOUT_MS: Ms(SECOND, 10 * MINUTE),
  /** Max time to process a request (routing to response); then 503 and request.signal aborts. */
  HTTP_HANDLER_TIMEOUT_MS: Ms(SECOND, 10 * MINUTE),
  /** Fastify `trustProxy`: set behind an ingress so per-IP limits see the client address. */
  HTTP_TRUST_PROXY: Type.Optional(Type.String({ pattern: TRUST_PROXY_PATTERN, maxLength: 1024 })),

  // ------------------------------------------------------------------ API ingress
  /** Requests per tenant per window (POST notifications and manual retries). */
  INGRESS_RATE_LIMIT: Count(1, 1_000_000),
  INGRESS_RATE_WINDOW_MS: Ms(100, HOUR),
  /** Webhook calls per provider instance per window. */
  WEBHOOK_RATE_LIMIT: Count(1, 1_000_000),
  WEBHOOK_RATE_WINDOW_MS: Ms(100, HOUR),
  /**
   * Webhook calls failing verification per provider instance per window. Counted separately
   * from WEBHOOK_RATE_*, which only counts verified calls, so forged traffic cannot starve them.
   */
  WEBHOOK_INVALID_RATE_LIMIT: Count(1, 1_000_000),
  WEBHOOK_INVALID_RATE_WINDOW_MS: Ms(100, HOUR),
  /**
   * Failed authentications (invalid API key, invalid webhook signature, unknown webhook instance)
   * per client IP per window; once exceeded the IP gets 429 before any database lookup.
   */
  AUTH_FAILURE_RATE_LIMIT: Count(1, 1_000_000),
  AUTH_FAILURE_RATE_WINDOW_MS: Ms(100, DAY),
  /** Read requests (GET notifications) per tenant per window. */
  READ_RATE_LIMIT: Count(1, 1_000_000),
  READ_RATE_WINDOW_MS: Ms(100, HOUR),

  // ------------------------------------------------------------------ Worker
  /** Worker lease on a delivery; renewed every third of it while a provider call is running. */
  DELIVERY_LEASE_MS: Ms(3 * SECOND, HOUR),
  /** Hard deadline of one provider call (may exceed the lease: the lease is renewed). */
  WORKER_SEND_TIMEOUT_MS: Ms(SECOND, HOUR),
  WORKER_CONCURRENCY: Count(1, 1_000),
  /** Deadline of one call to the shared limiter/breaker backend (Valkey). */
  LIMITS_BACKEND_TIMEOUT_MS: Ms(100, MINUTE),
  /** Default token bucket per provider instance (overridable per instance in config:apply). */
  PROVIDER_RATE_LIMIT_BURST: Count(1, 100_000),
  PROVIDER_RATE_LIMIT_PER_SECOND: Type.Number({ exclusiveMinimum: 0, maximum: 100_000 }),
  /** Default circuit breaker per provider instance (overridable per instance). */
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: Count(1, 1_000),
  CIRCUIT_BREAKER_FAILURE_WINDOW_MS: Ms(SECOND, HOUR),
  CIRCUIT_BREAKER_OPEN_MS: Ms(SECOND, HOUR),

  // ------------------------------------------------------------------ Retry policy
  RETRY_BACKOFF_BASE_MS: Ms(100, HOUR),
  RETRY_BACKOFF_MAX_MS: Ms(100, DAY),
  /** Randomized fraction of the exponential delay (0 = none, 1 = full jitter). */
  RETRY_JITTER_RATIO: Type.Number({ minimum: 0, maximum: 1 }),

  // ------------------------------------------------------------------ Dispatcher
  DISPATCHER_POLL_INTERVAL_MS: Ms(50, MINUTE),
  DISPATCHER_BATCH_SIZE: Count(1, 1_000),
  /** Consecutive full batches in one cycle before yielding to reconciliation. */
  DISPATCHER_MAX_BATCHES_PER_CYCLE: Count(1, 1_000),
  /** Outbox claim lease: a crashed dispatcher's events become claimable again after it. */
  OUTBOX_LEASE_MS: Ms(SECOND, HOUR),
  /** Upper bound of one queue publication. */
  QUEUE_PUBLISH_TIMEOUT_MS: Ms(100, MINUTE),

  // ------------------------------------------------------------------ Reconciliation
  RECONCILE_INTERVAL_MS: Ms(100, HOUR),
  RECONCILE_BATCH_SIZE: Count(1, 10_000),
  /** Published events whose job produced no activity for this long are re-armed. */
  LOST_PUBLICATION_AFTER_MS: Ms(SECOND, DAY),
  /** Minimum interval between two checks of the same `unknown` delivery. */
  UNKNOWN_CHECK_INTERVAL_MS: Ms(SECOND, DAY),
  /** Wait after an ambiguous attempt before a safe replay (lets webhooks arrive first). */
  UNKNOWN_REPLAY_DELAY_MS: Ms(0, DAY),
  /** Webhook events never correlated to a delivery are closed as orphans after this age. */
  PROVIDER_EVENT_ORPHAN_AFTER_MS: Ms(MINUTE, 30 * DAY),
  PROVIDER_EVENT_BATCH_SIZE: Count(1, 10_000),
});

export type AppConfig = Static<typeof EnvSchema>;

const DEFAULTS: Record<string, string> = {
  LOG_LEVEL: 'info',
  HTTP_HOST: '0.0.0.0',
  HTTP_PORT: '3000',
  OPS_HOST: '0.0.0.0',
  OPS_PORT: '9100',
  DATABASE_SSL: 'false',
  DATABASE_POOL_MAX: '10',
  DATABASE_CONNECT_TIMEOUT_MS: '10000',
  DATABASE_STATEMENT_TIMEOUT_MS: '15000',
  DATABASE_QUERY_TIMEOUT_MS: '20000',
  DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: '60000',
  DATABASE_POOL_IDLE_TIMEOUT_MS: '30000',
  DATABASE_KEEPALIVE_INITIAL_DELAY_MS: '10000',
  OUTBOX_BACKLOG_LIMIT: '10000',
  SHUTDOWN_GRACE_MS: '40000',
  HTTP_REQUEST_TIMEOUT_MS: '30000',
  HTTP_HANDLER_TIMEOUT_MS: '30000',
  INGRESS_RATE_LIMIT: '100',
  INGRESS_RATE_WINDOW_MS: '1000',
  WEBHOOK_RATE_LIMIT: '200',
  WEBHOOK_RATE_WINDOW_MS: '1000',
  WEBHOOK_INVALID_RATE_LIMIT: '50',
  WEBHOOK_INVALID_RATE_WINDOW_MS: '60000',
  AUTH_FAILURE_RATE_LIMIT: '30',
  AUTH_FAILURE_RATE_WINDOW_MS: '60000',
  READ_RATE_LIMIT: '300',
  READ_RATE_WINDOW_MS: '1000',
  DELIVERY_LEASE_MS: '60000',
  WORKER_SEND_TIMEOUT_MS: '30000',
  WORKER_CONCURRENCY: '10',
  LIMITS_BACKEND_TIMEOUT_MS: '2000',
  PROVIDER_RATE_LIMIT_BURST: '20',
  PROVIDER_RATE_LIMIT_PER_SECOND: '10',
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: '5',
  CIRCUIT_BREAKER_FAILURE_WINDOW_MS: '30000',
  CIRCUIT_BREAKER_OPEN_MS: '30000',
  RETRY_BACKOFF_BASE_MS: '5000',
  RETRY_BACKOFF_MAX_MS: '300000',
  RETRY_JITTER_RATIO: '0.5',
  DISPATCHER_POLL_INTERVAL_MS: '1000',
  DISPATCHER_BATCH_SIZE: '100',
  DISPATCHER_MAX_BATCHES_PER_CYCLE: '20',
  OUTBOX_LEASE_MS: '30000',
  QUEUE_PUBLISH_TIMEOUT_MS: '3000',
  RECONCILE_INTERVAL_MS: '10000',
  RECONCILE_BATCH_SIZE: '100',
  LOST_PUBLICATION_AFTER_MS: '300000',
  UNKNOWN_CHECK_INTERVAL_MS: '60000',
  UNKNOWN_REPLAY_DELAY_MS: '30000',
  PROVIDER_EVENT_ORPHAN_AFTER_MS: '3600000',
  PROVIDER_EVENT_BATCH_SIZE: '200',
};

function schemaType(schema: TSchema): unknown {
  return (schema as { type?: unknown }).type;
}

const PROPERTIES = EnvSchema.properties as Record<string, TSchema>;
const NUMERIC = new Set(
  Object.keys(PROPERTIES).filter((key) => {
    const type = schemaType(PROPERTIES[key] as TSchema);
    return type === 'integer' || type === 'number';
  }),
);
const BOOLEAN = new Set(
  Object.keys(PROPERTIES).filter((key) => schemaType(PROPERTIES[key] as TSchema) === 'boolean'),
);

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'ConfigError';
  }
}

/** Invariants between variables that a per-field schema cannot express. */
function crossFieldIssues(config: AppConfig): string[] {
  const issues: string[] = [];
  const remote = isRemoteEnvironment(config.APP_ENV);
  if (remote && !config.DATABASE_SSL) {
    issues.push('DATABASE_SSL must be true in stage/production');
  }
  if (remote && !config.VALKEY_URL.startsWith('rediss://')) {
    issues.push('VALKEY_URL must use rediss:// (TLS) in stage/production');
  }
  // A worker stopping must be able to finish (or deterministically abandon) an in-flight send and
  // record its outcome, which can involve two limiter/breaker calls, before being killed. Only
  // enforced in stage/production: local/test runs use short grace periods on purpose (shutdown
  // scenarios), and an exceeded grace never loses data (the attempt becomes `unknown` and is
  // reconciled), it only produces avoidable ambiguous attempts.
  if (
    remote &&
    config.SHUTDOWN_GRACE_MS <= config.WORKER_SEND_TIMEOUT_MS + 2 * config.LIMITS_BACKEND_TIMEOUT_MS
  ) {
    issues.push(
      'SHUTDOWN_GRACE_MS must exceed WORKER_SEND_TIMEOUT_MS + 2 x LIMITS_BACKEND_TIMEOUT_MS ' +
        'in stage/production',
    );
  }
  // The client deadline is the fallback for connections that cannot even be cancelled: it must
  // leave the server-side statement timeout room to fire first.
  if (config.DATABASE_QUERY_TIMEOUT_MS <= config.DATABASE_STATEMENT_TIMEOUT_MS) {
    issues.push('DATABASE_QUERY_TIMEOUT_MS must exceed DATABASE_STATEMENT_TIMEOUT_MS');
  }
  if (config.RETRY_BACKOFF_BASE_MS > config.RETRY_BACKOFF_MAX_MS) {
    issues.push('RETRY_BACKOFF_BASE_MS must not exceed RETRY_BACKOFF_MAX_MS');
  }
  // A publication that outlives the outbox lease is acknowledged too late (ack lost).
  if (config.QUEUE_PUBLISH_TIMEOUT_MS >= config.OUTBOX_LEASE_MS) {
    issues.push('QUEUE_PUBLISH_TIMEOUT_MS must be lower than OUTBOX_LEASE_MS');
  }
  // The lease is renewed every third of it; each renewal and every limiter call must fit well
  // inside one renewal period, otherwise a healthy worker could lose its lease.
  if (config.LIMITS_BACKEND_TIMEOUT_MS * 3 > config.DELIVERY_LEASE_MS) {
    issues.push('DELIVERY_LEASE_MS must be at least 3 x LIMITS_BACKEND_TIMEOUT_MS');
  }
  // Correlation is retried once per reconciliation cycle: closing an event as orphan before a
  // few cycles ran would drop webhooks that simply arrived before the attempt was committed.
  if (config.PROVIDER_EVENT_ORPHAN_AFTER_MS < config.RECONCILE_INTERVAL_MS * 3) {
    issues.push('PROVIDER_EVENT_ORPHAN_AFTER_MS must be at least 3 x RECONCILE_INTERVAL_MS');
  }
  // Re-arming is evaluated by the reconciler: a shorter age would re-arm healthy publications
  // that simply have not been looked at yet by a worker.
  if (config.LOST_PUBLICATION_AFTER_MS < config.DISPATCHER_POLL_INTERVAL_MS * 2) {
    issues.push('LOST_PUBLICATION_AFTER_MS must be at least 2 x DISPATCHER_POLL_INTERVAL_MS');
  }
  return issues;
}

export function isRemoteEnvironment(environment: AppEnvironment): boolean {
  return environment === 'stage' || environment === 'production';
}

/** Valid but risky settings, logged as warnings at startup (they never prevent it). */
export function configWarnings(config: AppConfig): string[] {
  const warnings: string[] = [];
  if (isRemoteEnvironment(config.APP_ENV) && config.PROVIDER_ALLOWED_HOSTS === undefined) {
    warnings.push(
      'PROVIDER_ALLOWED_HOSTS is not set: operator-configured provider endpoints are not ' +
        'restricted to an allow-list of destinations',
    );
  }
  return warnings;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const raw: Record<string, unknown> = {};
  for (const key of Object.keys(PROPERTIES)) {
    const value = env[key] ?? DEFAULTS[key];
    if (value === undefined || value === '') continue;
    if (NUMERIC.has(key)) raw[key] = Number(value);
    else if (BOOLEAN.has(key))
      raw[key] = value === 'true' ? true : value === 'false' ? false : value;
    else raw[key] = value;
  }

  if (!Value.Check(EnvSchema, raw)) {
    const issues = [...Value.Errors(EnvSchema, raw)].map(
      (e) => `${e.instancePath || '/'} ${e.message}`,
    );
    throw new ConfigError(issues);
  }

  const issues = crossFieldIssues(raw);
  if (issues.length > 0) throw new ConfigError(issues);
  return raw;
}
