import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Queue, type Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DispatchOutbox } from '../../../src/application/delivery/dispatch-outbox.js';
import { silentLogger } from '../../../src/application/delivery/ports.js';
import type { ProcessDelivery } from '../../../src/application/delivery/process-delivery.js';
import { Reconcile } from '../../../src/application/delivery/reconcile.js';
import { dispatchJobId } from '../../../src/contracts/jobs.js';
import {
  BullMqDeliveryPublisher,
  createDeliveryWorker,
} from '../../../src/infrastructure/queue/delivery-queue.js';
import { ValkeyTokenBucketRateLimiter } from '../../../src/infrastructure/queue/rate-limiter.js';
import {
  createProducerConnection,
  createWorkerConnection,
} from '../../../src/infrastructure/queue/valkey-connection.js';
import { closeOrm, migratedOrm, truncateAll } from '../database/support.js';
import { ready, TEST_VALKEY_URL, uniqueSuffix } from '../infra/test-env.js';
import {
  createDelivery,
  createDeliveryFixture,
  deliveryRow,
  FakeEmailAdapter,
  harness,
  outboxRows,
  processDelivery,
  reject,
  waitFor,
  type DeliveryFixture,
  type Harness,
} from './support.js';

const cleanups: (() => Promise<unknown>)[] = [];

async function runCleanups(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch {
      // best effort
    }
  }
}

function producer(url = TEST_VALKEY_URL): Redis {
  const connection = createProducerConnection(url);
  connection.on('error', () => undefined);
  cleanups.push(() => {
    connection.disconnect();
    return Promise.resolve();
  });
  return connection;
}

function consumer(url = TEST_VALKEY_URL): Redis {
  const connection = createWorkerConnection(url);
  connection.on('error', () => undefined);
  cleanups.push(() => {
    connection.disconnect();
    return Promise.resolve();
  });
  return connection;
}

describe('delivery pipeline: outbox -> BullMQ -> worker -> provider', () => {
  let orm: MikroORM;
  let adapter: FakeEmailAdapter;
  let h: Harness;
  let fixture: DeliveryFixture;
  let queueName: string;

  beforeAll(async () => {
    orm = await migratedOrm();
  });

  beforeEach(async () => {
    await truncateAll(orm);
    adapter = new FakeEmailAdapter('fake-smtp');
    h = harness(orm, [adapter]);
    fixture = await createDeliveryFixture(orm, [{ type: 'fake-smtp' }]);
    queueName = `test-email-${uniqueSuffix()}`;
  });

  afterEach(runCleanups);
  afterAll(closeOrm);

  async function publisherFor(url = TEST_VALKEY_URL, publishTimeoutMs = 1_000) {
    const connection = producer(url);
    if (url === TEST_VALKEY_URL) await ready(connection);
    const publisher = new BullMqDeliveryPublisher(connection, {
      queueNames: { email: queueName },
      publishTimeoutMs,
    });
    cleanups.push(() => publisher.close());
    return { connection, publisher };
  }

  function dispatcher(publisher: BullMqDeliveryPublisher, retryBaseMs = 1_000) {
    return new DispatchOutbox({
      outbox: h.repos.outbox,
      publisher,
      logger: silentLogger,
      options: { retryBaseMs, leaseMs: 30_000 },
    });
  }

  function startWorker(processor: ProcessDelivery, url = TEST_VALKEY_URL): Worker {
    const worker = createDeliveryWorker({
      queueName,
      connection: consumer(url),
      concurrency: 4,
      logger: silentLogger,
      handler: (data) => processor.execute(data),
    });
    cleanups.push(() => worker.close(true));
    return worker;
  }

  function inspectQueue(url = TEST_VALKEY_URL): Queue {
    const queue = new Queue(queueName, { connection: producer(url) });
    queue.on('error', () => undefined);
    cleanups.push(async () => {
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
    });
    return queue;
  }

  it('publishes references with the deterministic job id and the worker accepts', async () => {
    const deliveryId = await createDelivery(h.repos, orm, fixture);
    const { publisher } = await publisherFor();
    const queue = inspectQueue();
    startWorker(processDelivery(h));

    const report = await dispatcher(publisher).runOnce();
    expect(report).toEqual({ claimed: 1, published: 1, released: 0, ackLost: 0, yielded: 0 });
    const [event] = await outboxRows(orm, deliveryId);
    expect(event).toMatchObject({ status: 'published', dispatch_count: 1 });

    await waitFor(
      () => deliveryRow(orm, deliveryId),
      (row) => row.submission_status === 'accepted',
    );
    const job = await queue.getJob(dispatchJobId(Number(event?.id), 1));
    expect(job?.data).toEqual({ deliveryId, generation: 1, outboxEventId: event?.id });
    expect(job?.opts.attempts).toBe(1);
    expect(adapter.sends).toHaveLength(1);
  });

  it('retryable rejection goes through retry_wait and a new generation job', async () => {
    adapter.queue(reject('retryable'));
    const deliveryId = await createDelivery(h.repos, orm, fixture);
    const { publisher } = await publisherFor();
    inspectQueue();
    startWorker(
      processDelivery(h, {
        options: { retryPolicy: { baseDelayMs: 50, maxDelayMs: 100, jitterRatio: 0 } },
      }),
    );
    const dispatch = dispatcher(publisher);

    await waitFor(
      async () => {
        await dispatch.runOnce();
        return deliveryRow(orm, deliveryId);
      },
      (row) => row.submission_status === 'accepted',
    );
    expect((await deliveryRow(orm, deliveryId)).generation).toBe(2);
    expect(adapter.sends).toHaveLength(2);
  });

  it('a lost job is re-armed with a new job id and processed', async () => {
    const deliveryId = await createDelivery(h.repos, orm, fixture);
    const { publisher } = await publisherFor();
    const queue = inspectQueue();
    const dispatch = dispatcher(publisher);

    expect((await dispatch.runOnce()).published).toBe(1);

    const reconcile = new Reconcile({
      outbox: h.repos.outbox,
      deliveries: h.repos.deliveries,
      control: h.control,
      providerConfig: h.repos.providerConfig,
      receipts: h.repos.receipts,
      catalog: h.registry,
      secrets: { resolve: () => Promise.resolve(new Map()) },
      jobs: publisher,
      logger: silentLogger,
      options: { lostPublicationAfterMs: 0 },
    });
    // No worker yet: the job is still waiting in the queue (slow queue), not lost.
    expect(await reconcile.runOnce()).toMatchObject({ rearmed: 0, rearmSkippedQueued: 1 });

    // Simulate Valkey losing the job (e.g. restored from an older AOF).
    await queue.obliterate({ force: true });
    expect((await reconcile.runOnce()).rearmed).toBe(1);
    expect((await dispatch.runOnce()).published).toBe(1);
    const [event] = await outboxRows(orm, deliveryId);
    expect(event).toMatchObject({ status: 'published', dispatch_count: 2 });
    expect(await queue.getJob(dispatchJobId(Number(event?.id), 2))).toBeDefined();

    startWorker(processDelivery(h));
    await waitFor(
      () => deliveryRow(orm, deliveryId),
      (row) => row.submission_status === 'accepted',
    );
    // Re-arming an accepted delivery never happens: nothing left to re-arm.
    expect((await reconcile.runOnce()).rearmed).toBe(0);
    expect(adapter.sends).toHaveLength(1);
  });

  it('does not re-arm lost publications while the queue cannot be inspected', async () => {
    const deliveryId = await createDelivery(h.repos, orm, fixture);
    const { publisher } = await publisherFor();
    expect((await dispatcher(publisher).runOnce()).published).toBe(1);
    const reconcile = new Reconcile({
      outbox: h.repos.outbox,
      deliveries: h.repos.deliveries,
      control: h.control,
      providerConfig: h.repos.providerConfig,
      receipts: h.repos.receipts,
      catalog: h.registry,
      secrets: { resolve: () => Promise.resolve(new Map()) },
      jobs: { isJobPending: () => Promise.reject(new Error('valkey down')) },
      logger: silentLogger,
      options: { lostPublicationAfterMs: 0 },
    });
    expect(await reconcile.runOnce()).toMatchObject({ rearmed: 0, rearmSkippedQueued: 0 });
    expect((await outboxRows(orm, deliveryId))[0]).toMatchObject({ status: 'published' });
  });

  it('rate limit is respected across two workers sharing Valkey', async () => {
    const deliveries = await Promise.all(
      Array.from({ length: 5 }, () => createDelivery(h.repos, orm, fixture)),
    );
    const prefix = `ns-test:rl:${uniqueSuffix()}`;
    const limit = { burst: 2, perSecond: 0.001 };
    const limiterA = new ValkeyTokenBucketRateLimiter(await ready(producer()), {
      prefix,
      defaultLimit: limit,
    });
    const limiterB = new ValkeyTokenBucketRateLimiter(await ready(producer()), {
      prefix,
      defaultLimit: limit,
    });
    const workerA = processDelivery(h, { rateLimiter: limiterA });
    const workerB = processDelivery(h, { rateLimiter: limiterB });

    const jobs = await Promise.all(
      deliveries.map(async (deliveryId) => {
        const [event] = await outboxRows(orm, deliveryId);
        return { deliveryId, generation: 1, outboxEventId: Number(event?.id) };
      }),
    );
    const outcomes = await Promise.all(
      jobs.map((job, i) => (i % 2 === 0 ? workerA : workerB).execute(job)),
    );
    expect(outcomes.filter((o) => o === 'accepted')).toHaveLength(2);
    expect(outcomes.filter((o) => o === 'deferred')).toHaveLength(3);
    expect(adapter.sends).toHaveLength(2);
    for (const deliveryId of deliveries) {
      const row = await deliveryRow(orm, deliveryId);
      if (row.submission_status !== 'accepted') {
        expect(row).toMatchObject({ submission_status: 'pending', attempts_used: 0 });
      }
    }
  });

  it('suspends sending when the limiter backend is unreachable', async () => {
    const deliveryId = await createDelivery(h.repos, orm, fixture);
    const limiter = new ValkeyTokenBucketRateLimiter(producer('redis://127.0.0.1:1/1'), {
      commandTimeoutMs: 300,
    });
    const [event] = await outboxRows(orm, deliveryId);
    const outcome = await processDelivery(h, { rateLimiter: limiter }).execute({
      deliveryId,
      generation: 1,
      outboxEventId: Number(event?.id),
    });
    expect(outcome).toBe('deferred');
    expect(adapter.sends).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- Valkey outage (throwaway container)

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('no port'));
      });
    });
  });
}

const VALKEY_IMAGE = 'valkey/valkey:9.1.2-alpine';

describe.skipIf(!dockerAvailable())('dispatcher during a Valkey outage', () => {
  const container = `ns2b-valkey-outage-${uniqueSuffix()}`;
  let url: string;
  let orm: MikroORM;
  let adapter: FakeEmailAdapter;
  let h: Harness;
  let fixture: DeliveryFixture;

  beforeAll(async () => {
    const port = await freePort();
    url = `redis://127.0.0.1:${port}/0`;
    execFileSync('docker', [
      'run',
      '-d',
      '--name',
      container,
      '-p',
      `127.0.0.1:${port}:6379`,
      VALKEY_IMAGE,
    ]);
    orm = await migratedOrm();
  }, 60_000);

  afterAll(async () => {
    await runCleanups();
    execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' });
    await closeOrm();
  });

  beforeEach(async () => {
    await truncateAll(orm);
    adapter = new FakeEmailAdapter('fake-smtp');
    h = harness(orm, [adapter]);
    fixture = await createDeliveryFixture(orm, [{ type: 'fake-smtp' }]);
  });

  it('keeps outbox events re-publishable while Valkey is down and recovers afterwards', async () => {
    const queueName = `outage-${uniqueSuffix()}`;
    const connection = producer(url);
    await waitFor(
      () => Promise.resolve(connection.status),
      (status) => status === 'ready',
      20_000,
    );
    const publisher = new BullMqDeliveryPublisher(connection, {
      queueNames: { email: queueName },
      publishTimeoutMs: 1_000,
    });
    cleanups.push(() => publisher.close());
    const dispatch = new DispatchOutbox({
      outbox: h.repos.outbox,
      publisher,
      logger: silentLogger,
      options: { retryBaseMs: 10, retryMaxMs: 10 },
    });

    const deliveryId = await createDelivery(h.repos, orm, fixture);
    execFileSync('docker', ['stop', '-t', '0', container], { stdio: 'ignore' });
    await waitFor(
      () => Promise.resolve(connection.status),
      (status) => status !== 'ready',
      10_000,
    );

    const started = performance.now();
    const down = await dispatch.runOnce();
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(down).toMatchObject({ claimed: 1, published: 0, released: 1 });
    const [released] = await outboxRows(orm, deliveryId);
    expect(released).toMatchObject({ status: 'pending', dispatch_count: 1 });
    expect(String(released?.last_error)).toMatch(/queue_unavailable|publish_timeout/);

    // Still down on the next cycle: still re-publishable, never lost.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await dispatch.runOnce()).released).toBe(1);

    execFileSync('docker', ['start', container], { stdio: 'ignore' });
    await waitFor(
      () => Promise.resolve(connection.status),
      (status) => status === 'ready',
      20_000,
      100,
    );
    const recovered = await waitFor(
      () => dispatch.runOnce(),
      (report) => report.published === 1,
      10_000,
    );
    expect(recovered.released).toBe(0);
    const [event] = await outboxRows(orm, deliveryId);
    expect(event).toMatchObject({ status: 'published' });
    expect(Number(event?.dispatch_count)).toBeGreaterThanOrEqual(3);

    const worker = createDeliveryWorker({
      queueName,
      connection: consumer(url),
      concurrency: 1,
      logger: silentLogger,
      handler: (data) => processDelivery(h).execute(data),
    });
    cleanups.push(() => worker.close(true));
    await waitFor(
      () => deliveryRow(orm, deliveryId),
      (row) => row.submission_status === 'accepted',
    );
    expect(adapter.sends).toHaveLength(1);
  }, 60_000);
});
