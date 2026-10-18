import { MikroORM } from '@mikro-orm/postgresql';
import { Queue } from 'bullmq';
import { LoopWatchdog } from '../application/delivery/loop-watchdog.js';
import { ProcessDelivery } from '../application/delivery/process-delivery.js';
import { configWarnings, loadConfig } from '../config/env.js';
import {
  circuitBreakerProbeTtlMsOf,
  defaultCircuitBreakerOf,
  defaultSendRateLimitOf,
  processDeliveryOptionsOf,
  providerDeploymentPolicyOf,
} from '../config/runtime-settings.js';
import { QUEUE_NAMES } from '../contracts/jobs.js';
import { ormConfig } from '../infrastructure/database/orm-config.js';
import { createRepositories } from '../infrastructure/database/repositories.js';
import {
  registerQueueDepthCollector,
  registerValkeyMemoryCollector,
} from '../infrastructure/observability/collectors.js';
import { createLogger } from '../infrastructure/observability/logger.js';
import {
  dependencyReadiness,
  startProcessOps,
} from '../infrastructure/observability/process-ops.js';
import { PrometheusMetrics } from '../infrastructure/observability/prometheus-metrics.js';
import { createEmailProviderRegistry } from '../infrastructure/providers/registry.js';
import { ValkeyCircuitBreaker } from '../infrastructure/queue/circuit-breaker.js';
import { createDeliveryWorker } from '../infrastructure/queue/delivery-queue.js';
import { ValkeyTokenBucketRateLimiter } from '../infrastructure/queue/rate-limiter.js';
import {
  createProducerConnection,
  createWorkerConnection,
} from '../infrastructure/queue/valkey-connection.js';
import { installShutdown } from '../infrastructure/runtime/shutdown.js';
import { createSecretResolver } from '../infrastructure/security/secret-resolver.js';

const config = loadConfig();
const logger = createLogger(config, 'worker-email');
for (const warning of configWarnings(config)) logger.warn(warning);
const orm = await MikroORM.init(ormConfig(config));
await orm.connect();
const repositories = createRepositories(orm);
const registry = createEmailProviderRegistry(providerDeploymentPolicyOf(config));

// Blocking consumer connection: reconnects forever (BullMQ requirement).
const connection = createWorkerConnection(config.VALKEY_URL);
// Shared limits (token bucket, circuit breaker) use a fail-fast connection: when Valkey is not
// usable the worker suspends sending instead of bypassing quotas.
const limitsConnection = createProducerConnection(config.VALKEY_URL, {
  commandTimeout: config.LIMITS_BACKEND_TIMEOUT_MS,
});
limitsConnection.on('error', (err: Error) => {
  logger.debug({ err: err.message }, 'limits connection error');
});

const metrics = new PrometheusMetrics({
  service: 'worker',
  knownProviderTypes: registry.providerTypes(),
  logger,
});
registerValkeyMemoryCollector(metrics, limitsConnection);
// Read-only handle for queue depth (job counts); publishing stays with the dispatcher.
const depthQueue = new Queue(QUEUE_NAMES.email, { connection: limitsConnection });
depthQueue.on('error', () => undefined);
registerQueueDepthCollector(metrics, [depthQueue]);

const processDelivery = new ProcessDelivery({
  deliveries: repositories.deliveries,
  control: repositories.deliveryControl,
  providerConfig: repositories.providerConfig,
  suppressions: repositories.suppressions,
  catalog: registry,
  secrets: createSecretResolver({ secretsDir: config.SECRETS_DIR }),
  rateLimiter: new ValkeyTokenBucketRateLimiter(limitsConnection, {
    defaultLimit: defaultSendRateLimitOf(config),
    commandTimeoutMs: config.LIMITS_BACKEND_TIMEOUT_MS,
  }),
  breaker: new ValkeyCircuitBreaker(limitsConnection, {
    ...defaultCircuitBreakerOf(config),
    probeTtlMs: circuitBreakerProbeTtlMsOf(config),
    commandTimeoutMs: config.LIMITS_BACKEND_TIMEOUT_MS,
  }),
  logger,
  metrics,
  options: processDeliveryOptionsOf(config),
});

// Job liveness (constants for now; candidates for env vars). A job legitimately lasts up to the
// provider timeout plus the lease (recording retries); one running for much longer is hung
// (e.g. a database call that never returns) and holds a concurrency slot forever.
const JOBS = 'delivery_jobs';
const WATCHDOG_CHECK_MS = 5_000;
const jobStaleAfterMs = Math.max(
  60_000,
  2 * (config.WORKER_SEND_TIMEOUT_MS + config.DELIVERY_LEASE_MS),
);
const watchdog = new LoopWatchdog();
watchdog.registerInFlight(JOBS, {
  staleAfterMs: jobStaleAfterMs,
  fatalAfterMs: 2 * jobStaleAfterMs,
});

// Started before the consumer: a busy OPS_PORT exits before any job is fetched.
const ops = await startProcessOps({
  config,
  metrics,
  logger,
  readiness: dependencyReadiness({
    database: async () => (await orm.checkConnection()).ok,
    valkey: async () => (await limitsConnection.ping()).length > 0,
    jobs: () => Promise.resolve(watchdog.status().ready),
  }),
}).catch((error: unknown) => {
  logger.fatal({ err: error }, 'ops server failed to start');
  process.exit(1);
});

const worker = createDeliveryWorker({
  queueName: QUEUE_NAMES.email,
  connection,
  concurrency: config.WORKER_CONCURRENCY,
  logger,
  handler: (data) =>
    watchdog.track(JOBS, async () => {
      const outcome = await processDelivery.execute(data);
      logger.debug({ deliveryId: data.deliveryId, outcome }, 'delivery job processed');
      return outcome;
    }),
});

// A job stuck beyond the hard limit cannot recover on its own: exit so that the restart policy
// starts a fresh process (its delivery becomes `unknown` or re-runnable through the lease).
const stopWatchdog = watchdog.monitor(WATCHDOG_CHECK_MS, (status) => {
  logger.fatal({ loops: status.loops }, 'delivery job stuck beyond its hard limit: exiting');
  process.exit(1);
});

installShutdown(logger, config.SHUTDOWN_GRACE_MS, [
  () => {
    stopWatchdog();
    return Promise.resolve();
  },
  // Stops fetching new jobs and waits for in-flight ones (their outcome is persisted normally).
  // If the grace period expires first the process exits and the reconciler moves the leased
  // 'sending' deliveries to 'unknown': nothing is ever reported as sent without evidence.
  () => worker.close(),
  () => registry.closeAll(),
  async () => {
    await depthQueue.close().catch(() => undefined);
    await Promise.allSettled([connection.quit(), limitsConnection.quit()]);
  },
  () => ops.close(),
  () => orm.close(),
]);
logger.info(
  {
    queue: QUEUE_NAMES.email,
    concurrency: config.WORKER_CONCURRENCY,
    leaseMs: config.DELIVERY_LEASE_MS,
    sendTimeoutMs: config.WORKER_SEND_TIMEOUT_MS,
  },
  'worker started',
);
