import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../../src/config/env.js';
import { ormConfig } from '../../../src/infrastructure/database/orm-config.js';
import { E2E_ENV, databaseUrlFor } from './env.js';

export type Row = Record<string, unknown>;

async function connect(url: string): Promise<MikroORM> {
  const config = loadConfig({
    APP_ENV: 'test',
    DATABASE_URL: url,
    DATABASE_POOL_MAX: '4',
    VALKEY_URL: E2E_ENV.valkeyUrl,
    LOG_LEVEL: 'silent',
  });
  return MikroORM.init({ ...ormConfig(config), debug: false });
}

const SAFE_DB_NAME = /^notifications_e2e_[a-z0-9_]{1,40}$/;

/**
 * Per-file e2e database. The harness owns it: it is created on demand, emptied before the
 * migrations run (through the real `migrate` entrypoint) and only read by the assertions, except
 * for the explicit fault-injection helpers of the scenarios.
 */
export class E2eDatabase {
  private constructor(
    readonly name: string,
    readonly url: string,
    private readonly orm: MikroORM,
  ) {}

  /** Creates the database if missing (via the admin connection) and connects to it. */
  static async open(name: string): Promise<E2eDatabase> {
    await ensureDatabase(name);
    const url = databaseUrlFor(name);
    return new E2eDatabase(name, url, await connect(url));
  }

  /** Drops every object of the public schema: migrations then start from an empty database. */
  async reset(): Promise<void> {
    await this.orm.em
      .fork()
      .execute('drop schema if exists public cascade; create schema public;', [], 'run');
  }

  async query<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.orm.em.fork().execute<T[]>(sql, params);
  }

  async one<T extends Row = Row>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const rows = await this.query<T>(sql, params);
    return rows[0];
  }

  async count(sql: string, params: unknown[] = []): Promise<number> {
    const row = await this.one<{ count: unknown }>(sql, params);
    return Number(row?.count ?? 0);
  }

  async close(): Promise<void> {
    await this.orm.close(true);
  }
}

export async function ensureDatabase(name: string): Promise<void> {
  if (!SAFE_DB_NAME.test(name)) throw new Error(`Refusing to manage database "${name}"`);
  const admin = await connect(E2E_ENV.adminDatabaseUrl);
  try {
    const em = admin.em.fork();
    const exists = await em.execute<Row[]>('select 1 from pg_database where datname = ?', [name]);
    if (exists.length === 0) await em.execute(`create database ${name}`, [], 'run');
  } finally {
    await admin.close(true);
  }
}

export async function dropDatabase(name: string): Promise<void> {
  if (!SAFE_DB_NAME.test(name)) throw new Error(`Refusing to drop database "${name}"`);
  const admin = await connect(E2E_ENV.adminDatabaseUrl);
  try {
    await admin.em.fork().execute(`drop database if exists ${name} with (force)`, [], 'run');
  } finally {
    await admin.close(true);
  }
}
