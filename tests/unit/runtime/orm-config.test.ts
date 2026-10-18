import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DATABASE_TIMEOUTS,
  destroyClientOnReadTimeout,
  ormConfig,
  resolveDatabaseTimeouts,
} from '../../../src/infrastructure/database/orm-config.js';
import { MIGRATION_TIMEOUTS } from '../../../src/infrastructure/runtime/migration-lock.js';

const settings = {
  DATABASE_URL: 'postgres://u:p@db.invalid/n',
  DATABASE_SSL: true,
  DATABASE_POOL_MAX: 7,
};

describe('ormConfig database timeouts', () => {
  it('bounds connect, acquire, statements, client reads and idle transactions by default', () => {
    const config = ormConfig(settings);
    expect(config.pool).toEqual({ min: 0, max: 7 });
    expect(config.driverOptions).toMatchObject({
      ssl: { rejectUnauthorized: true },
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 15_000,
      query_timeout: 20_000,
      idle_in_transaction_session_timeout: 60_000,
    });
  });

  it('accepts overrides for the migrator (longer statements, two connections)', () => {
    const config = ormConfig(
      { ...settings, DATABASE_SSL: false, DATABASE_POOL_MAX: 1 },
      { timeouts: MIGRATION_TIMEOUTS, poolMax: 2 },
    );
    expect(config.pool).toEqual({ min: 0, max: 2 });
    expect(config.driverOptions).not.toHaveProperty('ssl');
    expect(config.driverOptions).toMatchObject({
      statement_timeout: MIGRATION_TIMEOUTS.statementTimeoutMs,
      query_timeout: MIGRATION_TIMEOUTS.queryTimeoutMs,
    });
  });

  it('requires the client read timeout to exceed the statement timeout', () => {
    expect(resolveDatabaseTimeouts()).toEqual(DEFAULT_DATABASE_TIMEOUTS);
    expect(() => resolveDatabaseTimeouts({ statementTimeoutMs: 20_000 })).toThrow(/queryTimeoutMs/);
  });
});

describe('destroyClientOnReadTimeout', () => {
  function fakeClient(outcome: () => Promise<unknown>) {
    const destroy = vi.fn();
    const client = {
      query: vi.fn<(...args: unknown[]) => Promise<unknown>>(() => outcome()),
      connection: { stream: { destroy } },
    };
    destroyClientOnReadTimeout(client);
    return { client, destroy };
  }

  it('destroys the socket after a client-side read timeout', async () => {
    const { client, destroy } = fakeClient(() => Promise.reject(new Error('Query read timeout')));
    await expect(client.query('select 1')).rejects.toThrow('Query read timeout');
    await Promise.resolve();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('leaves the connection alone on other errors and on success', async () => {
    const failing = fakeClient(() =>
      Promise.reject(Object.assign(new Error('canceled'), { code: '57014' })),
    );
    await expect(failing.client.query('select 1')).rejects.toThrow('canceled');
    const ok = fakeClient(() => Promise.resolve({ rows: [] }));
    await expect(ok.client.query('select 1')).resolves.toEqual({ rows: [] });
    await Promise.resolve();
    expect(failing.destroy).not.toHaveBeenCalled();
    expect(ok.destroy).not.toHaveBeenCalled();
  });
});
