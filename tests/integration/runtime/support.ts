import { MikroORM } from '@mikro-orm/postgresql';
import { pino } from 'pino';
import { TEST_DATABASE_URL, uniqueSuffix } from '../infra/test-env.js';
import {
  type OrmConfigOptions,
  ormConfig,
} from '../../../src/infrastructure/database/orm-config.js';

export const silentLogger = pino({ level: 'silent' });

export function databaseUrl(overrides: {
  host?: string;
  port?: number;
  database?: string;
}): string {
  const url = new URL(TEST_DATABASE_URL);
  if (overrides.host !== undefined) url.hostname = overrides.host;
  if (overrides.port !== undefined) url.port = String(overrides.port);
  if (overrides.database !== undefined) url.pathname = `/${overrides.database}`;
  return url.toString();
}

export function initOrm(url: string, options: OrmConfigOptions = {}): Promise<MikroORM> {
  return MikroORM.init({
    ...ormConfig({ DATABASE_URL: url, DATABASE_SSL: false, DATABASE_POOL_MAX: 4 }, options),
    debug: false,
  });
}

const SAFE_NAME = /^[a-z0-9_]+$/;

/** Creates an empty, uniquely named database next to the test database; returns its name. */
export async function createScratchDatabase(prefix: string): Promise<string> {
  const name = `${prefix}_${uniqueSuffix()}`.toLowerCase();
  if (!SAFE_NAME.test(name)) throw new Error(`unsafe database name ${name}`);
  const admin = await initOrm(TEST_DATABASE_URL);
  try {
    await admin.em.fork().execute(`create database ${name}`, [], 'run');
  } finally {
    await admin.close();
  }
  return name;
}

export async function dropScratchDatabase(name: string): Promise<void> {
  if (!SAFE_NAME.test(name)) throw new Error(`unsafe database name ${name}`);
  const admin = await initOrm(TEST_DATABASE_URL);
  try {
    await admin.em.fork().execute(`drop database if exists ${name} with (force)`, [], 'run');
  } finally {
    await admin.close();
  }
}
