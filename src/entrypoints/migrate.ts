import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../config/env.js';
import { ormConfig } from '../infrastructure/database/orm-config.js';
import { createLogger } from '../infrastructure/observability/logger.js';
import { MIGRATION_TIMEOUTS, migrateWithLock } from '../infrastructure/runtime/migration-lock.js';

const config = loadConfig();
const logger = createLogger(config, 'migrate');
// One connection holds the advisory lock, the migrator needs another: at least two.
const orm = await MikroORM.init(
  ormConfig(config, {
    timeouts: MIGRATION_TIMEOUTS,
    poolMax: Math.max(2, config.DATABASE_POOL_MAX),
  }),
);
try {
  const applied = await migrateWithLock(orm, logger);
  logger.info({ applied }, 'migrations applied');
} finally {
  await orm.close();
}
