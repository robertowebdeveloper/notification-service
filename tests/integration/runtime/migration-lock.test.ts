import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import type { MikroORM } from '@mikro-orm/postgresql';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateWithLock } from '../../../src/infrastructure/runtime/migration-lock.js';
import { TEST_VALKEY_URL } from '../infra/test-env.js';
import {
  createScratchDatabase,
  databaseUrl,
  dropScratchDatabase,
  initOrm,
  silentLogger,
} from './support.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const MIGRATIONS = readdirSync(path.join(ROOT, 'src/infrastructure/database/migrations'))
  .filter((file) => /^Migration\d+_.*\.ts$/.test(file) && !file.endsWith('.d.ts'))
  .map((file) => file.replace(/\.ts$/, ''))
  .sort();

async function appliedMigrations(url: string): Promise<string[]> {
  const orm = await initOrm(url);
  try {
    const rows = await orm.em
      .fork()
      .execute<{ name: string }[]>('select name from mikro_orm_migrations order by name');
    return rows.map((r) => r.name);
  } finally {
    await orm.close();
  }
}

function runMigrateProcess(url: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      path.join(ROOT, 'node_modules/.bin/tsx'),
      [path.join(ROOT, 'src/entrypoints/migrate.ts')],
      {
        cwd: ROOT,
        env: {
          PATH: process.env.PATH,
          APP_ENV: 'test',
          LOG_LEVEL: 'info',
          DATABASE_URL: url,
          DATABASE_SSL: 'false',
          DATABASE_POOL_MAX: '2',
          VALKEY_URL: TEST_VALKEY_URL,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, output });
    });
  });
}

describe('migration advisory lock', () => {
  const databases: string[] = [];
  const orms: MikroORM[] = [];

  afterEach(async () => {
    await Promise.all(orms.splice(0).map((orm) => orm.close(true)));
    for (const name of databases.splice(0)) await dropScratchDatabase(name);
  });

  it('serializes two concurrent in-process runs on a fresh database', async () => {
    const name = await createScratchDatabase('ns_migrate_lock');
    databases.push(name);
    const url = databaseUrl({ database: name });
    const a = await initOrm(url);
    const b = await initOrm(url);
    orms.push(a, b);

    const results = await Promise.all([
      migrateWithLock(a, silentLogger),
      migrateWithLock(b, silentLogger),
    ]);

    expect(MIGRATIONS.length).toBeGreaterThan(0);
    expect(results.map((r) => r.length).sort()).toEqual([0, MIGRATIONS.length]);
    expect(results.flat().sort()).toEqual(MIGRATIONS);
    expect(await appliedMigrations(url)).toEqual(MIGRATIONS);
  });

  it('lets two concurrent migrate processes both exit 0', async () => {
    const name = await createScratchDatabase('ns_migrate_lock');
    databases.push(name);
    const url = databaseUrl({ database: name });

    const runs = await Promise.all([runMigrateProcess(url), runMigrateProcess(url)]);

    for (const run of runs) expect(run.code, run.output).toBe(0);
    expect(await appliedMigrations(url)).toEqual(MIGRATIONS);
  }, 60_000);
});
