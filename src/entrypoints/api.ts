import { MikroORM } from '@mikro-orm/postgresql';
import { configWarnings, loadConfig } from '../config/env.js';
import {
  authFailureRateLimitOf,
  httpServerSettingsOf,
  ingressRateLimitOf,
  providerDeploymentPolicyOf,
  readRateLimitOf,
  webhookInvalidRateLimitOf,
  webhookRateLimitOf,
} from '../config/runtime-settings.js';
import { BacklogGuard } from '../application/notifications/ingress-guards.js';
import { PgSenderPolicyRepository } from '../infrastructure/database/api-support-repositories.js';
import { PgManualRetryRepository } from '../infrastructure/database/manual-retry-repository.js';
import { ormConfig } from '../infrastructure/database/orm-config.js';
import { createRepositories } from '../infrastructure/database/repositories.js';
import {
  ormPoolStats,
  registerDbPoolCollector,
} from '../infrastructure/observability/collectors.js';
import { createLogger, loggerOptions } from '../infrastructure/observability/logger.js';
import { startProcessOps } from '../infrastructure/observability/process-ops.js';
import { PrometheusMetrics } from '../infrastructure/observability/prometheus-metrics.js';
import { createEmailProviderRegistry } from '../infrastructure/providers/registry.js';
import { createProducerConnection } from '../infrastructure/queue/valkey-connection.js';
import { installShutdown } from '../infrastructure/runtime/shutdown.js';
import { createSecretResolver } from '../infrastructure/security/secret-resolver.js';
import { createApiDependencies } from '../http/api-dependencies.js';
import { buildApp } from '../http/app.js';
import { ValkeyRateLimiter } from '../http/rate-limit/valkey-rate-limiter.js';

const config = loadConfig();
const logger = createLogger(config, 'api');
for (const warning of configWarnings(config)) logger.warn(warning);
const orm = await MikroORM.init(ormConfig(config));
await orm.connect();

const repositories = createRepositories(orm);
const registry = createEmailProviderRegistry(providerDeploymentPolicyOf(config));
const metrics = new PrometheusMetrics({
  service: 'api',
  knownProviderTypes: registry.providerTypes(),
  logger,
});
registerDbPoolCollector(metrics, ormPoolStats(orm, config.DATABASE_POOL_MAX));
const secrets = createSecretResolver({ secretsDir: config.SECRETS_DIR });

// Rate limiting only: the API never depends on Valkey to accept requests (outbox in PostgreSQL).
const valkey = createProducerConnection(config.VALKEY_URL, { lazyConnect: false });
valkey.on('error', (err) => {
  logger.warn({ err: { message: err.message } }, 'valkey connection error (rate limit fails open)');
});

const backlog = new BacklogGuard(
  () => repositories.notifications.countPendingOutbox(),
  config.OUTBOX_BACKLOG_LIMIT,
);

const app = await buildApp({
  logger: loggerOptions(config, 'api'),
  http: httpServerSettingsOf(config),
  readiness: async () => {
    const database = (await orm.checkConnection()).ok;
    let backlogOk = false;
    if (database) {
      try {
        backlogOk = !(await backlog.isOverLimit());
      } catch {
        backlogOk = false;
      }
    }
    return { ready: database && backlogOk, checks: { database, backlog: backlogOk } };
  },
  api: createApiDependencies({
    notifications: repositories.notifications,
    manualRetries: new PgManualRetryRepository(orm),
    apiKeys: repositories.apiKeys,
    providerConfig: repositories.providerConfig,
    providerEvents: repositories.providerEvents,
    senderPolicy: new PgSenderPolicyRepository(orm),
    registry,
    secrets,
    rateLimiter: new ValkeyRateLimiter(valkey),
    backlog,
    logger,
    ingressLimit: ingressRateLimitOf(config),
    webhookLimit: webhookRateLimitOf(config),
    webhookInvalidLimit: webhookInvalidRateLimitOf(config),
    authFailureLimit: authFailureRateLimitOf(config),
    readLimit: readRateLimitOf(config),
    metrics,
  }),
});

// Metrics only: the API's health endpoints stay on the public port.
const ops = await startProcessOps({ config, metrics, logger }).catch((error: unknown) => {
  logger.fatal({ err: error }, 'ops server failed to start');
  process.exit(1);
});

installShutdown(logger, config.SHUTDOWN_GRACE_MS, [
  () => app.close(),
  async () => {
    valkey.disconnect();
    return Promise.resolve();
  },
  () => registry.closeAll(),
  () => ops.close(),
  () => orm.close(),
]);
await app.listen({ host: config.HTTP_HOST, port: config.HTTP_PORT });
