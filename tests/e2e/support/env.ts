import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

/**
 * Static configuration of the e2e harness. Every value can be overridden from the environment so
 * the suite can run against a different local infrastructure (e.g. CI services).
 */
export const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');

export const E2E_ENV = {
  /** Database used only to create/drop the per-file e2e databases (needs CREATEDB). */
  adminDatabaseUrl:
    process.env.E2E_ADMIN_DATABASE_URL ??
    'postgres://notifications:notifications@localhost:5432/notifications',
  /** Valkey server; each scenario file uses its own DB index (its "slot"). */
  valkeyUrl: process.env.E2E_VALKEY_URL ?? 'redis://localhost:6379',
  mailpitApiUrl: process.env.E2E_MAILPIT_API_URL ?? 'http://localhost:8025/api/v1',
  mailpitSmtpHost: process.env.E2E_MAILPIT_SMTP_HOST ?? 'localhost',
  mailpitSmtpPort: Number(process.env.E2E_MAILPIT_SMTP_PORT ?? '1025'),
  /** Log level of the child processes (pino). */
  serviceLogLevel: process.env.E2E_SERVICE_LOG_LEVEL ?? 'debug',
  /** When set, the output of every child process is written to this directory. */
  logDir: process.env.E2E_LOG_DIR,
} as const;

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer`);
  return value;
}

/**
 * Extra environment for every service process, as a JSON object
 * (e.g. `E2E_SERVICE_ENV='{"DELIVERY_LEASE_MS":"20000"}'`). It overrides SERVICE_TUNING, and the
 * TIMING budget below is derived from the effective values, so the two always agree.
 */
export function serviceEnvOverrides(): Record<string, string> {
  const raw = process.env.E2E_SERVICE_ENV;
  if (raw === undefined || raw === '') return {};
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('E2E_SERVICE_ENV must be a JSON object of strings');
  }
  return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
}

/**
 * Runtime settings (src/config/env.ts) shortened for the suite. Only timing knobs are changed;
 * the semantics under test (budgets, fencing, no blind resend) are the production ones.
 */
export const SERVICE_TUNING: Record<string, string> = {
  DELIVERY_LEASE_MS: '10000',
  RECONCILE_INTERVAL_MS: '1000',
  LOST_PUBLICATION_AFTER_MS: '15000',
  UNKNOWN_CHECK_INTERVAL_MS: '2000',
  UNKNOWN_REPLAY_DELAY_MS: '2000',
  OUTBOX_LEASE_MS: '5000',
  DISPATCHER_POLL_INTERVAL_MS: '250',
  RETRY_BACKOFF_BASE_MS: '1000',
  RETRY_BACKOFF_MAX_MS: '10000',
  RETRY_JITTER_RATIO: '0.5',
  ...serviceEnvOverrides(),
};

function tuning(name: string, fallback: number): number {
  const value = Number(SERVICE_TUNING[name] ?? fallback);
  return Number.isFinite(value) ? value : fallback;
}

const leaseMs = tuning('DELIVERY_LEASE_MS', 60_000);
const reconcileMs = tuning('RECONCILE_INTERVAL_MS', 10_000);
const backoffBaseMs = tuning('RETRY_BACKOFF_BASE_MS', 5_000);
const jitterRatio = tuning('RETRY_JITTER_RATIO', 0.5);

/**
 * Timing budget of the suite, derived from SERVICE_TUNING (each value overridable with E2E_*).
 */
export const TIMING = {
  /** Child process startup (tsx compile + DB/Valkey connections). */
  startupMs: intFromEnv('E2E_STARTUP_TIMEOUT_MS', 30_000),
  /** Normal path: request -> dispatcher -> worker -> provider -> committed result. */
  deliveryMs: intFromEnv('E2E_DELIVERY_TIMEOUT_MS', 30_000),
  /** Recovery path: lease expiry + reconciliation cycle (+ backoff for retries), generous. */
  recoveryMs: intFromEnv('E2E_RECOVERY_TIMEOUT_MS', Math.max(60_000, 3 * (leaseMs + reconcileMs))),
  /** Window used for negative assertions ("nothing else happens"). */
  settleMs: intFromEnv('E2E_SETTLE_MS', Math.max(5_000, 3 * reconcileMs)),
  /** Delivery lease configured in the services. */
  leaseMs: intFromEnv('E2E_LEASE_MS', leaseMs),
  /** Age after which the reconciler re-arms a published event whose job was lost. */
  lostPublicationMs: intFromEnv(
    'E2E_LOST_PUBLICATION_MS',
    tuning('LOST_PUBLICATION_AFTER_MS', 300_000),
  ),
  /** Upper bound the worker puts on one provider call. */
  workerSendTimeoutMs: intFromEnv(
    'E2E_WORKER_SEND_TIMEOUT_MS',
    tuning('WORKER_SEND_TIMEOUT_MS', 30_000),
  ),
  /** Lower bound between two attempts after a certain retryable rejection (base x (1-jitter)). */
  minBackoffMs: intFromEnv(
    'E2E_MIN_BACKOFF_MS',
    Math.max(0, Math.floor(backoffBaseMs * (1 - jitterRatio)) - 50),
  ),
  /** Default SHUTDOWN_GRACE_MS given to the services. */
  shutdownGraceMs: intFromEnv('E2E_SHUTDOWN_GRACE_MS', 10_000),
} as const;

/** Replaces the database name of a postgres URL. */
export function databaseUrlFor(databaseName: string): string {
  const url = new URL(E2E_ENV.adminDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

/** Valkey URL selecting a DB index. */
export function valkeyUrlFor(dbIndex: number): string {
  const url = new URL(E2E_ENV.valkeyUrl);
  url.pathname = `/${dbIndex}`;
  return url.toString();
}

/** A currently free loopback TCP port. */
export async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve) =>
    probe.close(() => {
      resolve();
    }),
  );
  return port;
}
