import { join } from 'node:path';
import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import type { AppConfig } from '../../config/env.js';
import { ENTITIES } from './entities.js';

/**
 * Bounds on every PostgreSQL interaction. `pg` waits forever by default, so a connection that stops
 * answering (failover, blackholed host) would hang a query, and the process with it.
 */
export interface DatabaseTimeouts {
  /** TCP connect + startup, and waiting for a free pool client (`connectionTimeoutMillis`). */
  connectTimeoutMs: number;
  /** Server-side `statement_timeout`: the server cancels the statement, the connection survives. */
  statementTimeoutMs: number;
  /**
   * Client-side `query_timeout`, for when the server cannot even cancel (connection dead or
   * blackholed). Must exceed `statementTimeoutMs`. On expiry the connection is destroyed, so the
   * pool never hands it out again.
   */
  queryTimeoutMs: number;
  /** Server-side `idle_in_transaction_session_timeout`: frees locks of an abandoned transaction. */
  idleInTransactionTimeoutMs: number;
  /** Idle pool clients are closed after this long (`idleTimeoutMillis`). */
  poolIdleTimeoutMs: number;
  /** TCP keepalive initial delay: dead peers are noticed even on idle pooled connections. */
  keepAliveInitialDelayMs: number;
}

/** Same values as the DATABASE_*_MS defaults of src/config/env.ts (used when settings omit them). */
export const DEFAULT_DATABASE_TIMEOUTS: Readonly<DatabaseTimeouts> = Object.freeze({
  connectTimeoutMs: 10_000,
  statementTimeoutMs: 15_000,
  queryTimeoutMs: 20_000,
  idleInTransactionTimeoutMs: 60_000,
  poolIdleTimeoutMs: 30_000,
  keepAliveInitialDelayMs: 10_000,
});

type TimeoutSettings = Pick<
  AppConfig,
  | 'DATABASE_CONNECT_TIMEOUT_MS'
  | 'DATABASE_STATEMENT_TIMEOUT_MS'
  | 'DATABASE_QUERY_TIMEOUT_MS'
  | 'DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS'
  | 'DATABASE_POOL_IDLE_TIMEOUT_MS'
  | 'DATABASE_KEEPALIVE_INITIAL_DELAY_MS'
>;

/** Connection settings; the DATABASE_*_MS timeouts default to DEFAULT_DATABASE_TIMEOUTS. */
export type OrmSettings = Pick<AppConfig, 'DATABASE_URL' | 'DATABASE_SSL' | 'DATABASE_POOL_MAX'> &
  Partial<TimeoutSettings>;

/** Timeouts configured through the environment (DATABASE_*_MS), missing ones left out. */
export function databaseTimeoutsOf(config: Partial<TimeoutSettings>): Partial<DatabaseTimeouts> {
  const entries: [keyof DatabaseTimeouts, number | undefined][] = [
    ['connectTimeoutMs', config.DATABASE_CONNECT_TIMEOUT_MS],
    ['statementTimeoutMs', config.DATABASE_STATEMENT_TIMEOUT_MS],
    ['queryTimeoutMs', config.DATABASE_QUERY_TIMEOUT_MS],
    ['idleInTransactionTimeoutMs', config.DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS],
    ['poolIdleTimeoutMs', config.DATABASE_POOL_IDLE_TIMEOUT_MS],
    ['keepAliveInitialDelayMs', config.DATABASE_KEEPALIVE_INITIAL_DELAY_MS],
  ];
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined));
}

export interface OrmConfigOptions {
  timeouts?: Partial<DatabaseTimeouts>;
  /** Overrides DATABASE_POOL_MAX (e.g. the migrator needs a second connection for its lock). */
  poolMax?: number;
}

/** Minimal shapes of the untyped `pg` objects touched here. */
interface PgClient {
  query: (...args: unknown[]) => unknown;
  connection?: { stream?: { destroy: () => void } };
  setTypeParser?: (oid: number, parser: (value: string) => unknown) => void;
}
interface PgPool {
  on(event: 'connect', listener: (client: PgClient) => void): unknown;
}

const READ_TIMEOUT_MESSAGE = 'Query read timeout';
const INT8_OID = 20;

/**
 * bigint (int8) values, i.e. identity ids and bigint counts, as JS numbers. Values beyond
 * Number.MAX_SAFE_INTEGER stay text (never rounded): id readers reject them.
 */
export function parseInt8(value: string): number | string {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : value;
}

/** Installed per connection; the type overrides object is shared by this pool's clients only. */
export function useNumericInt8(client: PgClient): void {
  client.setTypeParser?.(INT8_OID, parseInt8);
}

/**
 * After a `query_timeout` the statement is still in flight on the socket, so the client would be
 * returned to the pool and every later query on it would queue behind a reply that never comes.
 * Destroying the socket marks the client as not queryable: the pool discards it on release.
 */
export function destroyClientOnReadTimeout(client: PgClient): void {
  const query = client.query.bind(client);
  client.query = (...args: unknown[]) => {
    const result = query(...args);
    if (result instanceof Promise) {
      result.catch((err: unknown) => {
        if (err instanceof Error && err.message === READ_TIMEOUT_MESSAGE) {
          client.connection?.stream?.destroy();
        }
      });
    }
    return result;
  };
}

export function resolveDatabaseTimeouts(
  overrides: Partial<DatabaseTimeouts> = {},
): DatabaseTimeouts {
  const timeouts = { ...DEFAULT_DATABASE_TIMEOUTS, ...overrides };
  if (timeouts.statementTimeoutMs > 0 && timeouts.queryTimeoutMs <= timeouts.statementTimeoutMs) {
    throw new Error('queryTimeoutMs must exceed statementTimeoutMs');
  }
  return timeouts;
}

/** Precedence: DEFAULT_DATABASE_TIMEOUTS < DATABASE_*_MS settings < `options.timeouts`. */
export function ormConfig(config: OrmSettings, options: OrmConfigOptions = {}) {
  const t = resolveDatabaseTimeouts({ ...databaseTimeoutsOf(config), ...options.timeouts });
  return defineConfig({
    clientUrl: config.DATABASE_URL,
    entities: [...ENTITIES],
    pool: { min: 0, max: options.poolMax ?? config.DATABASE_POOL_MAX },
    driverOptions: {
      ...(config.DATABASE_SSL ? { ssl: { rejectUnauthorized: true } } : {}),
      keepAlive: true,
      keepAliveInitialDelayMillis: t.keepAliveInitialDelayMs,
      connectionTimeoutMillis: t.connectTimeoutMs,
      idleTimeoutMillis: t.poolIdleTimeoutMs,
      statement_timeout: t.statementTimeoutMs,
      query_timeout: t.queryTimeoutMs,
      idle_in_transaction_session_timeout: t.idleInTransactionTimeoutMs,
      onPoolCreated: (pool: PgPool) => {
        pool.on('connect', (client) => {
          useNumericInt8(client);
          destroyClientOnReadTimeout(client);
        });
      },
    },
    extensions: [Migrator],
    migrations: {
      path: join(import.meta.dirname, 'migrations'),
      glob: '!(*.d).{js,ts}',
      tableName: 'mikro_orm_migrations',
      transactional: true,
      allOrNothing: true,
      emit: 'ts',
      // Never write .snapshot-<db>.json next to the migrations at runtime.
      snapshot: false,
    },
    allowGlobalContext: false,
  });
}
