import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { MikroORM } from '@mikro-orm/postgresql';
import { configWarnings, loadConfig } from '../config/env.js';
import { providerDeploymentPolicyOf } from '../config/runtime-settings.js';
import { applyConfig } from '../application/admin/apply-config.js';
import { ConfigFileError, parseConfigFile } from '../application/admin/config-file.js';
import { PgApiKeyAdminLookup } from '../infrastructure/database/api-support-repositories.js';
import { ormConfig } from '../infrastructure/database/orm-config.js';
import { createRepositories } from '../infrastructure/database/repositories.js';
import { createLogger } from '../infrastructure/observability/logger.js';
import { createEmailProviderRegistry } from '../infrastructure/providers/registry.js';
import { generateApiKey } from '../infrastructure/security/api-keys.js';

const { values } = parseArgs({ options: { file: { type: 'string' } } });
const config = loadConfig();
const logger = createLogger(config, 'config-apply');
for (const warning of configWarnings(config)) logger.warn(warning);

if (values.file === undefined) {
  logger.error('usage: npm run config:apply -- --file <path>');
  process.exit(2);
}

let file;
try {
  file = parseConfigFile(JSON.parse(await readFile(values.file, 'utf8')));
} catch (error) {
  if (error instanceof ConfigFileError)
    logger.error({ issues: error.issues }, 'invalid config file');
  else logger.error({ err: error, file: values.file }, 'cannot read config file');
  process.exit(1);
}

const orm = await MikroORM.init(ormConfig(config));
// Same deployment policy as the runtime (APP_ENV, PROVIDER_ALLOWED_HOSTS): a configuration the
// worker would refuse is rejected here, before anything is written.
const registry = createEmailProviderRegistry(providerDeploymentPolicyOf(config));
let exitCode = 0;
try {
  const repositories = createRepositories(orm);
  // One transaction for the whole file (PgAdminConfigRepository.inTransaction): applyConfig
  // returns only after the commit, and fails without writing anything otherwise.
  const result = await applyConfig(file, {
    admin: repositories.adminConfig,
    apiKeys: new PgApiKeyAdminLookup(orm),
    providers: registry,
    generateApiKey,
    appEnv: config.APP_ENV,
    actor: 'config:apply',
  });
  logger.info({ file: values.file, changed: result.changed }, 'configuration applied');
  // New keys are printed exactly once, after the commit, on stdout; never logged or stored in
  // clear. The write is awaited so process.exit cannot truncate it on an asynchronous pipe.
  const printed = result.createdApiKeys
    .map((key) => `API key created for tenant "${key.tenant}" (${key.name}): ${key.plaintext}\n`)
    .join('');
  if (printed !== '') {
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(printed, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
} catch (error) {
  if (error instanceof ConfigFileError)
    logger.error({ issues: error.issues }, 'invalid config file');
  else logger.error({ err: error }, 'config:apply failed');
  exitCode = 1;
} finally {
  await registry.closeAll();
  await orm.close();
}
process.exit(exitCode);
