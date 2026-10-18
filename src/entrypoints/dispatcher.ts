import { MikroORM } from '@mikro-orm/postgresql';
import { DispatchOutbox } from '../application/delivery/dispatch-outbox.js';
import { limitsForInterval, LoopWatchdog } from '../application/delivery/loop-watchdog.js';
import { ProcessProviderEvents } from '../application/delivery/process-provider-events.js';
import { Reconcile } from '../application/delivery/reconcile.js';
import { configWarnings, loadConfig } from '../config/env.js';
import {
  dispatcherLoopOf,
  dispatchOutboxOptionsOf,
  providerEventOptionsOf,
  reconcileOptionsOf,
  providerDeploymentPolicyOf,
} from '../config/runtime-settings.js';
import { ormConfig } from '../infrastructure/database/orm-config.js';
import { createRepositories } from '../infrastructure/database/repositories.js';
import {
  ormPoolStats,
  queryOutboxBacklog,
  registerDbPoolCollector,
  registerOutboxCollector,
  registerValkeyMemoryCollector,
} from '../infrastructure/observability/collectors.js';
import { createLogger } from '../infrastructure/observability/logger.js';
import {
  dependencyReadiness,
  startProcessOps,
} from '../infrastructure/observability/process-ops.js';
import { PrometheusMetrics } from '../infrastructure/observability/prometheus-metrics.js';
import { createEmailProviderRegistry } from '../infrastructure/providers/registry.js';
import { BullMqDeliveryPublisher } from '../infrastructure/queue/delivery-queue.js';
import { createProducerConnection } from '../infrastructure/queue/valkey-connection.js';
import { installShutdown } from '../infrastructure/runtime/shutdown.js';
import { createSecretResolver } from '../infrastructure/security/secret-resolver.js';

const config = loadConfig();
const loop = dispatcherLoopOf(config);
const logger = createLogger(config, 'dispatcher');
for (const warning of configWarnings(config)) logger.warn(warning);
const orm = await MikroORM.init(ormConfig(config));
await orm.connect();
const repositories = createRepositories(orm);
const control = repositories.deliveryControl;
const registry = createEmailProviderRegistry(providerDeploymentPolicyOf(config));

const connection = createProducerConnection(config.VALKEY_URL);
connection.on('error', (err: Error) => {
  logger.debug({ err: err.message }, 'queue connection error');
});
const metrics = new PrometheusMetrics({
  service: 'dispatcher',
  knownProviderTypes: registry.providerTypes(),
  logger,
});
registerOutboxCollector(metrics, () => queryOutboxBacklog(orm));
registerDbPoolCollector(metrics, ormPoolStats(orm, config.DATABASE_POOL_MAX));
registerValkeyMemoryCollector(metrics, connection);

const publisher = new BullMqDeliveryPublisher(connection, {
  publishTimeoutMs: loop.publishTimeoutMs,
});

// Loop liveness (constants for now; candidates for env vars). The publication loop beats after
// every batch (bounded by the outbox lease); reconciliation beats after every step and every
// unknown delivery checked (each bounded by the status query timeout).
const PUBLISH_LOOP = 'outbox_publish';
const RECONCILE_LOOP = 'reconcile';
const WATCHDOG_CHECK_MS = 5_000;
const watchdog = new LoopWatchdog();
watchdog.registerLoop(
  PUBLISH_LOOP,
  limitsForInterval(loop.pollIntervalMs, Math.max(30_000, 2 * config.OUTBOX_LEASE_MS)),
);
watchdog.registerLoop(RECONCILE_LOOP, limitsForInterval(loop.reconcileIntervalMs));

const dispatch = new DispatchOutbox({
  outbox: repositories.outbox,
  publisher,
  logger,
  metrics,
  options: { ...dispatchOutboxOptionsOf(config), publishTimeoutMs: loop.publishTimeoutMs },
});
const reconcile = new Reconcile({
  outbox: repositories.outbox,
  deliveries: repositories.deliveries,
  control,
  providerConfig: repositories.providerConfig,
  receipts: repositories.receipts,
  catalog: registry,
  secrets: createSecretResolver({ secretsDir: config.SECRETS_DIR }),
  providerEvents: new ProcessProviderEvents({
    events: repositories.providerEvents,
    receipts: repositories.receipts,
    suppressions: repositories.suppressions,
    control,
    logger,
    metrics,
    options: providerEventOptionsOf(config),
  }),
  jobs: publisher,
  onProgress: () => {
    watchdog.beat(RECONCILE_LOOP);
  },
  logger,
  metrics,
  options: reconcileOptionsOf(config),
});

// Started before the loop: a busy OPS_PORT exits before any outbox event is claimed.
const ops = await startProcessOps({
  config,
  metrics,
  logger,
  readiness: dependencyReadiness({
    database: async () => (await orm.checkConnection()).ok,
    valkey: async () => (await connection.ping()).length > 0,
    loops: () => Promise.resolve(watchdog.status().ready),
  }),
}).catch((error: unknown) => {
  logger.fatal({ err: error }, 'ops server failed to start');
  process.exit(1);
});

const state = { running: true };
const isRunning = (): boolean => state.running;
const wakers = new Set<() => void>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const wake = () => {
      clearTimeout(timer);
      wakers.delete(wake);
      resolve();
    };
    const timer = setTimeout(wake, ms);
    wakers.add(wake);
  });
}

/** One independent loop: a slow reconciliation never delays outbox publication. */
async function runLoop(name: string, intervalMs: number, cycle: () => Promise<void>) {
  while (state.running) {
    try {
      await cycle();
    } catch (err: unknown) {
      logger.error({ err, loop: name }, 'dispatcher cycle failed');
    }
    watchdog.beat(name);
    if (isRunning()) await sleep(intervalMs);
  }
}

const publishDone = runLoop(PUBLISH_LOOP, loop.pollIntervalMs, async () => {
  // Bounded burst: consecutive full batches, each limited by the outbox lease time budget.
  for (let batch = 0; batch < loop.maxBatchesPerCycle && state.running; batch += 1) {
    const report = await dispatch.runOnce();
    watchdog.beat(PUBLISH_LOOP);
    if (report.claimed > 0) logger.debug({ ...report }, 'outbox dispatch');
    if (report.claimed < loop.batchSize || report.released > 0) break;
  }
});

const reconcileDone = runLoop(RECONCILE_LOOP, loop.reconcileIntervalMs, async () => {
  const report = await reconcile.runOnce();
  logger.debug({ ...report }, 'reconciliation');
});

// A loop stuck beyond its hard limit (e.g. a query that never returns) cannot recover on its
// own: exit so that the restart policy starts a fresh process. Readiness already reports it.
const stopWatchdog = watchdog.monitor(WATCHDOG_CHECK_MS, (status) => {
  logger.fatal({ loops: status.loops }, 'dispatcher loop stuck beyond its hard limit: exiting');
  process.exit(1);
});

installShutdown(logger, config.SHUTDOWN_GRACE_MS, [
  // Stop acquiring outbox events and let the current cycle finish (publications are bounded).
  async () => {
    stopWatchdog();
    state.running = false;
    for (const wake of [...wakers]) wake();
    await Promise.all([publishDone, reconcileDone]);
  },
  () => publisher.close(),
  async () => {
    await connection.quit().catch(() => undefined);
  },
  () => registry.closeAll(),
  () => ops.close(),
  () => orm.close(),
]);
logger.info(
  {
    pollIntervalMs: loop.pollIntervalMs,
    reconcileIntervalMs: loop.reconcileIntervalMs,
    batchSize: loop.batchSize,
  },
  'dispatcher started',
);
