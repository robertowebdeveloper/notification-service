import { describe, expect, it } from 'vitest';
import { ConfigError, configWarnings, loadConfig } from '../../src/config/env.js';
import { ormConfig } from '../../src/infrastructure/database/orm-config.js';
import {
  authFailureRateLimitOf,
  defaultCircuitBreakerOf,
  defaultSendRateLimitOf,
  dispatcherLoopOf,
  httpServerSettingsOf,
  ingressRateLimitOf,
  processDeliveryOptionsOf,
  providerDeploymentPolicyOf,
  providerEventOptionsOf,
  readRateLimitOf,
  reconcileOptionsOf,
  webhookInvalidRateLimitOf,
  webhookRateLimitOf,
} from '../../src/config/runtime-settings.js';

const base = {
  APP_ENV: 'local',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  VALKEY_URL: 'redis://localhost:6379',
};

/** Minimal valid stage/production environment. */
const remote = {
  ...base,
  APP_ENV: 'production',
  DATABASE_SSL: 'true',
  VALKEY_URL: 'rediss://valkey.internal:6379',
};

describe('loadConfig', () => {
  it('applies defaults for local environment', () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({ APP_ENV: 'local', HTTP_PORT: 3000, DATABASE_SSL: false });
  });

  it('rejects missing connection URLs', () => {
    expect(() => loadConfig({ APP_ENV: 'local' })).toThrow(ConfigError);
  });

  it('requires APP_ENV: a missing value never silently means local', () => {
    const withoutEnv: Record<string, string> = { ...base };
    delete withoutEnv.APP_ENV;
    expect(() => loadConfig(withoutEnv)).toThrow(/APP_ENV/);
    expect(() => loadConfig({ ...withoutEnv, APP_ENV: '' })).toThrow(/APP_ENV/);
    expect(() => loadConfig({ ...base, APP_ENV: 'prod' })).toThrow(ConfigError);
  });

  it('requires database TLS in production', () => {
    expect(() => loadConfig({ ...remote, DATABASE_SSL: 'false' })).toThrow(/DATABASE_SSL/);
    expect(loadConfig(remote).DATABASE_SSL).toBe(true);
  });

  it.each(['stage', 'production'])('requires rediss:// for Valkey in %s', (env) => {
    expect(() => loadConfig({ ...remote, APP_ENV: env, VALKEY_URL: 'redis://v:6379' })).toThrow(
      /VALKEY_URL must use rediss/,
    );
    expect(loadConfig({ ...remote, APP_ENV: env }).VALKEY_URL).toBe(
      'rediss://valkey.internal:6379',
    );
    expect(loadConfig({ ...base, APP_ENV: 'test' }).VALKEY_URL).toBe('redis://localhost:6379');
  });

  it('requires a shutdown grace longer than one send plus two limiter calls in stage/production', () => {
    // Defaults: 30000 + 2 x 2000 = 34000 < 40000.
    expect(loadConfig(remote).SHUTDOWN_GRACE_MS).toBe(40_000);
    expect(() => loadConfig({ ...remote, SHUTDOWN_GRACE_MS: '34000' })).toThrow(
      /SHUTDOWN_GRACE_MS must exceed WORKER_SEND_TIMEOUT_MS \+ 2 x LIMITS_BACKEND_TIMEOUT_MS/,
    );
    expect(() =>
      loadConfig({ ...remote, SHUTDOWN_GRACE_MS: '25000', WORKER_SEND_TIMEOUT_MS: '20000' }),
    ).not.toThrow();
    // local/test keep short grace periods possible (shutdown scenarios).
    expect(() => loadConfig({ ...base, SHUTDOWN_GRACE_MS: '2000' })).not.toThrow();
  });

  it('validates PROVIDER_ALLOWED_HOSTS and warns in stage/production when it is unset', () => {
    expect(configWarnings(loadConfig(remote)).join('\n')).toMatch(/PROVIDER_ALLOWED_HOSTS/);
    expect(configWarnings(loadConfig(base))).toEqual([]);
    const restricted = loadConfig({
      ...remote,
      PROVIDER_ALLOWED_HOSTS: 'smtp.example.com, .resend.com',
    });
    expect(configWarnings(restricted)).toEqual([]);
    expect(providerDeploymentPolicyOf(restricted)).toEqual({
      environment: 'production',
      allowedHosts: ['smtp.example.com', '.resend.com'],
    });
    expect(providerDeploymentPolicyOf(loadConfig(base))).toEqual({
      environment: 'local',
      allowedHosts: undefined,
    });
    for (const invalid of ['https://api.resend.com', 'smtp.example.com:587', 'a b', ',']) {
      expect(() => loadConfig({ ...base, PROVIDER_ALLOWED_HOSTS: invalid })).toThrow(ConfigError);
    }
  });

  it('validates the database timeouts and feeds them to the ORM', () => {
    expect(loadConfig(base)).toMatchObject({
      DATABASE_CONNECT_TIMEOUT_MS: 10_000,
      DATABASE_STATEMENT_TIMEOUT_MS: 15_000,
      DATABASE_QUERY_TIMEOUT_MS: 20_000,
      DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: 60_000,
      DATABASE_POOL_IDLE_TIMEOUT_MS: 30_000,
      DATABASE_KEEPALIVE_INITIAL_DELAY_MS: 10_000,
    });
    expect(() => loadConfig({ ...base, DATABASE_QUERY_TIMEOUT_MS: '15000' })).toThrow(
      /DATABASE_QUERY_TIMEOUT_MS must exceed DATABASE_STATEMENT_TIMEOUT_MS/,
    );
    expect(() => loadConfig({ ...base, DATABASE_CONNECT_TIMEOUT_MS: '999' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, DATABASE_POOL_IDLE_TIMEOUT_MS: '600001' })).toThrow(
      ConfigError,
    );

    const config = loadConfig({
      ...base,
      DATABASE_CONNECT_TIMEOUT_MS: '5000',
      DATABASE_STATEMENT_TIMEOUT_MS: '7000',
      DATABASE_QUERY_TIMEOUT_MS: '9000',
      DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: '11000',
      DATABASE_POOL_IDLE_TIMEOUT_MS: '13000',
      DATABASE_KEEPALIVE_INITIAL_DELAY_MS: '17000',
    });
    expect(ormConfig(config).driverOptions).toMatchObject({
      connectionTimeoutMillis: 5_000,
      statement_timeout: 7_000,
      query_timeout: 9_000,
      idle_in_transaction_session_timeout: 11_000,
      idleTimeoutMillis: 13_000,
      keepAliveInitialDelayMillis: 17_000,
    });
    // Explicit overrides (the migrator) still win over the environment.
    expect(
      ormConfig(config, { timeouts: { statementTimeoutMs: 60_000, queryTimeoutMs: 90_000 } })
        .driverOptions,
    ).toMatchObject({
      statement_timeout: 60_000,
      query_timeout: 90_000,
      connectionTimeoutMillis: 5_000,
    });
  });

  it('maps HTTP server timeouts and proxy trust', () => {
    expect(httpServerSettingsOf(loadConfig(base))).toEqual({
      requestTimeoutMs: 30_000,
      handlerTimeoutMs: 30_000,
      trustProxy: false,
    });
    const tuned = (value: string) =>
      httpServerSettingsOf(loadConfig({ ...base, HTTP_TRUST_PROXY: value })).trustProxy;
    expect(tuned('true')).toBe(true);
    expect(tuned('2')).toBe(2);
    expect(tuned('10.0.0.0/8, 192.168.1.1')).toBe('10.0.0.0/8,192.168.1.1');
    expect(() => loadConfig({ ...base, HTTP_TRUST_PROXY: 'yes please' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, HTTP_HANDLER_TIMEOUT_MS: '0' })).toThrow(ConfigError);
  });
});

describe('loadConfig: tunable runtime settings', () => {
  it('keeps the documented operational defaults', () => {
    expect(loadConfig(base)).toMatchObject({
      INGRESS_RATE_LIMIT: 100,
      INGRESS_RATE_WINDOW_MS: 1_000,
      WEBHOOK_RATE_LIMIT: 200,
      WEBHOOK_RATE_WINDOW_MS: 1_000,
      WEBHOOK_INVALID_RATE_LIMIT: 50,
      WEBHOOK_INVALID_RATE_WINDOW_MS: 60_000,
      AUTH_FAILURE_RATE_LIMIT: 30,
      AUTH_FAILURE_RATE_WINDOW_MS: 60_000,
      READ_RATE_LIMIT: 300,
      READ_RATE_WINDOW_MS: 1_000,
      HTTP_REQUEST_TIMEOUT_MS: 30_000,
      HTTP_HANDLER_TIMEOUT_MS: 30_000,
      SHUTDOWN_GRACE_MS: 40_000,
      DELIVERY_LEASE_MS: 60_000,
      WORKER_SEND_TIMEOUT_MS: 30_000,
      WORKER_CONCURRENCY: 10,
      LIMITS_BACKEND_TIMEOUT_MS: 2_000,
      PROVIDER_RATE_LIMIT_BURST: 20,
      PROVIDER_RATE_LIMIT_PER_SECOND: 10,
      CIRCUIT_BREAKER_FAILURE_THRESHOLD: 5,
      CIRCUIT_BREAKER_FAILURE_WINDOW_MS: 30_000,
      CIRCUIT_BREAKER_OPEN_MS: 30_000,
      RETRY_BACKOFF_BASE_MS: 5_000,
      RETRY_BACKOFF_MAX_MS: 300_000,
      RETRY_JITTER_RATIO: 0.5,
      DISPATCHER_POLL_INTERVAL_MS: 1_000,
      DISPATCHER_BATCH_SIZE: 100,
      DISPATCHER_MAX_BATCHES_PER_CYCLE: 20,
      OUTBOX_LEASE_MS: 30_000,
      QUEUE_PUBLISH_TIMEOUT_MS: 3_000,
      RECONCILE_INTERVAL_MS: 10_000,
      RECONCILE_BATCH_SIZE: 100,
      LOST_PUBLICATION_AFTER_MS: 300_000,
      UNKNOWN_CHECK_INTERVAL_MS: 60_000,
      UNKNOWN_REPLAY_DELAY_MS: 30_000,
      PROVIDER_EVENT_ORPHAN_AFTER_MS: 3_600_000,
      PROVIDER_EVENT_BATCH_SIZE: 200,
    });
  });

  it('parses overrides, including fractional rates', () => {
    const config = loadConfig({
      ...base,
      DELIVERY_LEASE_MS: '6000',
      WORKER_SEND_TIMEOUT_MS: '20000',
      PROVIDER_RATE_LIMIT_PER_SECOND: '0.5',
      RETRY_JITTER_RATIO: '0',
      WORKER_CONCURRENCY: '2',
    });
    expect(config).toMatchObject({
      DELIVERY_LEASE_MS: 6_000,
      WORKER_SEND_TIMEOUT_MS: 20_000,
      PROVIDER_RATE_LIMIT_PER_SECOND: 0.5,
      RETRY_JITTER_RATIO: 0,
      WORKER_CONCURRENCY: 2,
    });
  });

  it('allows a send timeout longer than the lease (the lease is renewed while sending)', () => {
    expect(() =>
      loadConfig({ ...base, DELIVERY_LEASE_MS: '6000', WORKER_SEND_TIMEOUT_MS: '60000' }),
    ).not.toThrow();
  });

  it.each([
    ['WORKER_CONCURRENCY', '0'],
    ['WORKER_CONCURRENCY', '2.5'],
    ['DELIVERY_LEASE_MS', 'soon'],
    ['DELIVERY_LEASE_MS', '1000'],
    ['PROVIDER_RATE_LIMIT_PER_SECOND', '0'],
    ['RETRY_JITTER_RATIO', '1.5'],
    ['INGRESS_RATE_LIMIT', '-1'],
  ])('rejects %s=%s', (name, value) => {
    expect(() => loadConfig({ ...base, [name]: value })).toThrow(ConfigError);
  });

  it.each([
    [{ RETRY_BACKOFF_BASE_MS: '600000', RETRY_BACKOFF_MAX_MS: '300000' }, /RETRY_BACKOFF_BASE_MS/],
    [{ QUEUE_PUBLISH_TIMEOUT_MS: '30000', OUTBOX_LEASE_MS: '30000' }, /QUEUE_PUBLISH_TIMEOUT_MS/],
    [{ LIMITS_BACKEND_TIMEOUT_MS: '3000', DELIVERY_LEASE_MS: '6000' }, /DELIVERY_LEASE_MS/],
    [
      { PROVIDER_EVENT_ORPHAN_AFTER_MS: '60000', RECONCILE_INTERVAL_MS: '30000' },
      /PROVIDER_EVENT_ORPHAN_AFTER_MS/,
    ],
    [
      { LOST_PUBLICATION_AFTER_MS: '1000', DISPATCHER_POLL_INTERVAL_MS: '1000' },
      /LOST_PUBLICATION_AFTER_MS/,
    ],
  ])('rejects inconsistent combinations %o', (overrides, message) => {
    expect(() => loadConfig({ ...base, ...overrides })).toThrow(message);
  });
});

describe('runtime settings mapping', () => {
  it('feeds use-case options from the environment', () => {
    const config = loadConfig({
      ...base,
      DELIVERY_LEASE_MS: '9000',
      WORKER_SEND_TIMEOUT_MS: '12000',
      RETRY_BACKOFF_BASE_MS: '1000',
      RETRY_BACKOFF_MAX_MS: '4000',
      PROVIDER_RATE_LIMIT_BURST: '3',
      PROVIDER_RATE_LIMIT_PER_SECOND: '1.5',
      CIRCUIT_BREAKER_FAILURE_THRESHOLD: '2',
    });
    expect(processDeliveryOptionsOf(config)).toEqual({
      leaseMs: 9_000,
      sendTimeoutMs: 12_000,
      retryPolicy: { baseDelayMs: 1_000, maxDelayMs: 4_000, jitterRatio: 0.5 },
    });
    expect(defaultSendRateLimitOf(config)).toEqual({ burst: 3, perSecond: 1.5 });
    expect(defaultCircuitBreakerOf(config)).toEqual({
      failureThreshold: 2,
      failureWindowMs: 30_000,
      openMs: 30_000,
    });
    expect(ingressRateLimitOf(config)).toEqual({ limit: 100, windowMs: 1_000 });
    expect(webhookRateLimitOf(config)).toEqual({ limit: 200, windowMs: 1_000 });
    expect(webhookInvalidRateLimitOf(config)).toEqual({ limit: 50, windowMs: 60_000 });
    expect(authFailureRateLimitOf(config)).toEqual({ limit: 30, windowMs: 60_000 });
    expect(readRateLimitOf(config)).toEqual({ limit: 300, windowMs: 1_000 });
    expect(reconcileOptionsOf(config)).toMatchObject({
      lostPublicationAfterMs: 300_000,
      retryPolicy: { baseDelayMs: 1_000 },
    });
    expect(providerEventOptionsOf(config)).toEqual({ batchSize: 200, orphanAfterMs: 3_600_000 });
    expect(dispatcherLoopOf(config)).toEqual({
      pollIntervalMs: 1_000,
      reconcileIntervalMs: 10_000,
      maxBatchesPerCycle: 20,
      batchSize: 100,
      publishTimeoutMs: 3_000,
    });
  });
});
