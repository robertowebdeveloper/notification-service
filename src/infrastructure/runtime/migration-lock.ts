import type { MikroORM } from '@mikro-orm/postgresql';
import type { Logger } from 'pino';

/** Dedicated advisory lock key of the migrator (arbitrary, stable, unique to this service). */
export const MIGRATION_LOCK_KEY = 7_412_038_551;

/** Statements may wait on the lock or rewrite large tables: generous but still bounded. */
export const MIGRATION_TIMEOUTS = Object.freeze({
  statementTimeoutMs: 15 * 60_000,
  queryTimeoutMs: 15 * 60_000 + 30_000,
});

interface LockPool {
  connect(): Promise<LockClient>;
}
interface LockClient {
  query(sql: string, params?: unknown[]): Promise<unknown>;
  release(err?: Error | boolean): void;
}

/**
 * Applies pending migrations while holding a session-level advisory lock on one dedicated pooled
 * connection (the migrator uses other connections, so the pool needs at least two). Concurrent runs
 * serialize: the second one waits, then finds nothing pending and returns an empty list.
 */
export async function migrateWithLock(orm: MikroORM, logger: Logger): Promise<string[]> {
  // `pg` ships no types: describe the two calls used here.
  const pool = (await orm.em.getConnection().getNativeClient()) as unknown as LockPool;
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    logger.info({ lockKey: MIGRATION_LOCK_KEY }, 'waiting for migration lock');
    await client.query('select pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_KEY]);
    try {
      const applied = await orm.migrator.up();
      return applied.map((m) => m.name);
    } finally {
      try {
        await client.query('select pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_KEY]);
      } catch (err) {
        // The session lock goes away with the connection, which is then discarded.
        broken = err instanceof Error ? err : new Error(String(err));
      }
    }
  } catch (err) {
    broken ??= err instanceof Error ? err : new Error(String(err));
    throw err;
  } finally {
    client.release(broken);
  }
}
