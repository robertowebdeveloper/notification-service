import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MikroORM, defineConfig } from '@mikro-orm/postgresql';
import { TEST_DATABASE_URL, uniqueSuffix } from './test-env.js';

describe('PostgreSQL infrastructure', () => {
  const table = `infra_smoke_${uniqueSuffix()}`;
  let orm: MikroORM;

  beforeAll(async () => {
    orm = await MikroORM.init(
      defineConfig({
        clientUrl: TEST_DATABASE_URL,
        entities: [],
        discovery: { warnWhenNoEntities: false },
        pool: { min: 0, max: 4 },
        debug: false,
      }),
    );
    await orm.connect();
    await orm.em.getConnection().execute(`create table ${table} (id int primary key)`);
    await orm.em.getConnection().execute(`insert into ${table} (id) select generate_series(1, 4)`);
  });

  afterAll(async () => {
    await orm.em.getConnection().execute(`drop table if exists ${table}`);
    await orm.close();
  });

  it('is reachable and runs PostgreSQL 18', async () => {
    expect(await orm.checkConnection()).toEqual({ ok: true });
    const [row] = await orm.em
      .getConnection()
      .execute<{ server_version_num: string }[]>('show server_version_num');
    expect(Number(row?.server_version_num)).toBeGreaterThanOrEqual(180_000);
  });

  it('lets concurrent transactions claim disjoint rows with FOR UPDATE SKIP LOCKED', async () => {
    const claim = `select id from ${table} order by id limit 2 for update skip locked`;
    let releaseFirst!: () => void;
    const firstHoldsLocks = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let signalLocked!: () => void;
    const firstLocked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });

    const first = orm.em.fork().transactional(async (em) => {
      const rows = await em.execute<{ id: number }[]>(claim);
      signalLocked();
      await firstHoldsLocks;
      return rows.map((r) => r.id);
    });

    await firstLocked;
    const second = await orm.em.fork().transactional(async (em) => {
      const rows = await em.execute<{ id: number }[]>(claim);
      return rows.map((r) => r.id);
    });
    releaseFirst();

    expect(await first).toEqual([1, 2]);
    expect(second).toEqual([3, 4]);
  });
});
