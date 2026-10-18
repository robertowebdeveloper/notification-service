import { afterAll, describe, expect, it } from 'vitest';
import { Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  createProducerConnection,
  createWorkerConnection,
} from '../../../src/infrastructure/queue/valkey-connection.js';
import { TEST_VALKEY_URL, uniqueSuffix } from './test-env.js';

const cleanups: (() => Promise<unknown>)[] = [];

afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

describe('BullMQ on Valkey', () => {
  it('delivers a job from a producer queue to a worker', async () => {
    const queueName = `infra-smoke-${uniqueSuffix()}`;
    const producer = createProducerConnection(TEST_VALKEY_URL);
    const workerConnection = createWorkerConnection(TEST_VALKEY_URL);
    const queue = new Queue<{ value: number }>(queueName, { connection: producer });
    cleanups.push(
      () => producer.quit(),
      () => workerConnection.quit(),
      () => queue.close(),
      () => queue.obliterate({ force: true }),
    );

    const processed = new Promise<{ id: string | undefined; result: unknown }>(
      (resolve, reject) => {
        const worker = new Worker<{ value: number }, number>(
          queueName,
          (job) => Promise.resolve(job.data.value * 2),
          { connection: workerConnection },
        );
        cleanups.push(() => worker.close());
        worker.on('completed', (job, result) => {
          resolve({ id: job.id, result });
        });
        worker.on('failed', (_job, err) => {
          reject(err);
        });
      },
    );

    const job = await queue.add('smoke', { value: 21 }, { jobId: 'smoke-1' });
    await expect(processed).resolves.toEqual({ id: job.id, result: 42 });
  });
});

describe('producer connection to an unavailable Valkey', () => {
  function closedPortConnection(): Redis {
    const connection = createProducerConnection('redis://127.0.0.1:1/1');
    connection.on('error', () => undefined);
    cleanups.push(() => {
      connection.disconnect();
      return Promise.resolve();
    });
    return connection;
  }

  it('fails commands within a bounded time', async () => {
    const connection = closedPortConnection();
    const started = performance.now();
    await expect(connection.ping()).rejects.toThrow();
    expect(performance.now() - started).toBeLessThan(6_000);
  });

  it('does not bound queue publication by itself: the dispatcher must apply its own deadline', async () => {
    // BullMQ waits for the connection to become ready and the producer retryStrategy reconnects
    // forever, so Queue.add stays pending (it does not settle even after disconnect) while Valkey
    // is down. The dispatcher must race it with its own timeout and leave the event re-publishable.
    const connection = closedPortConnection();
    const queue = new Queue(`infra-smoke-${uniqueSuffix()}`, { connection });
    queue.on('error', () => undefined);
    const outcome = queue.add('smoke', { value: 1 }).then(
      () => 'published',
      () => 'rejected',
    );
    const deadline = new Promise<string>((resolve) =>
      setTimeout(() => {
        resolve('pending');
      }, 1_500),
    );
    expect(await Promise.race([outcome, deadline])).toBe('pending');
    await queue.close();
  });
});
