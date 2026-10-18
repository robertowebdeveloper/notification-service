import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  QueuePublishError,
  type DeliveryJobInspector,
  type DeliveryJobPublisher,
  type DeliveryLogger,
} from '../../application/delivery/ports.js';
import type { Channel } from '../../contracts/channels.js';
import { QUEUE_NAMES, type DeliveryJobData } from '../../contracts/jobs.js';
import { OperationTimeoutError, withTimeout } from './with-timeout.js';

export const DELIVERY_JOB_NAME = 'dispatch_delivery';

/** Delivery jobs never retry inside BullMQ: PostgreSQL owns budget and schedule. */
export const DELIVERY_JOB_OPTIONS = Object.freeze({
  attempts: 1,
  removeOnComplete: { age: 24 * 3600, count: 10_000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 50_000 },
});

export interface BullMqPublisherOptions {
  /** Queue name per channel; defaults to the frozen `QUEUE_NAMES`. */
  queueNames?: Partial<Record<Channel, string>>;
  /** Upper bound of one publication; past it the outbox event is released for a later retry. */
  publishTimeoutMs?: number;
}

/**
 * Producer used by the dispatcher. BullMQ waits for a ready connection and never settles
 * `Queue.add` while Valkey is down, so every publication checks the connection state first and
 * is raced against its own deadline. A publication that times out may still land later: the
 * job id is unique per dispatch and duplicate jobs are harmless (the worker re-checks the DB).
 */
/** Job states meaning "will still run" (a slow queue, not a lost job). */
const PENDING_JOB_STATES: ReadonlySet<string> = new Set([
  'waiting',
  'waiting-children',
  'prioritized',
  'delayed',
  'active',
]);

export class BullMqDeliveryPublisher implements DeliveryJobPublisher, DeliveryJobInspector {
  private readonly queues = new Map<Channel, Queue<DeliveryJobData>>();
  private readonly timeoutMs: number;

  constructor(
    private readonly connection: Redis,
    options: BullMqPublisherOptions = {},
  ) {
    this.timeoutMs = options.publishTimeoutMs ?? 3_000;
    const names: Partial<Record<Channel, string>> = { ...QUEUE_NAMES, ...options.queueNames };
    for (const [channel, name] of Object.entries(names) as [Channel, string | undefined][]) {
      if (name === undefined) continue;
      const queue = new Queue<DeliveryJobData>(name, {
        connection,
        defaultJobOptions: DELIVERY_JOB_OPTIONS,
      });
      // Connection errors surface through publish(); avoid unhandled 'error' events.
      queue.on('error', () => undefined);
      this.queues.set(channel, queue);
    }
  }

  async publish(channel: Channel, jobId: string, data: DeliveryJobData): Promise<void> {
    const queue = this.queues.get(channel);
    if (queue === undefined) {
      throw new QueuePublishError('no_queue', `No queue configured for channel ${channel}`);
    }
    if (this.connection.status !== 'ready') {
      throw new QueuePublishError(
        'queue_unavailable',
        `Queue connection is ${this.connection.status}`,
      );
    }
    const payload: DeliveryJobData = {
      deliveryId: data.deliveryId,
      generation: data.generation,
      outboxEventId: data.outboxEventId,
    };
    try {
      await withTimeout(
        queue.add(DELIVERY_JOB_NAME, payload, { ...DELIVERY_JOB_OPTIONS, jobId }),
        this.timeoutMs,
        'queue publish',
      );
    } catch (error) {
      if (error instanceof OperationTimeoutError) {
        throw new QueuePublishError('publish_timeout', error.message);
      }
      throw new QueuePublishError(
        'publish_failed',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * True when the job is waiting/delayed/active. Missing, completed or failed jobs count as not
   * pending. Throws (bounded by the publish timeout) when Valkey cannot answer.
   */
  async isJobPending(channel: Channel, jobId: string): Promise<boolean> {
    const queue = this.queues.get(channel);
    if (queue === undefined) return false;
    if (this.connection.status !== 'ready') {
      throw new QueuePublishError(
        'queue_unavailable',
        `Queue connection is ${this.connection.status}`,
      );
    }
    const state = await withTimeout(queue.getJobState(jobId), this.timeoutMs, 'queue inspect');
    return PENDING_JOB_STATES.has(state);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.queues.values()].map((queue) => queue.close()));
  }
}

function isPositiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function isDeliveryJobData(value: unknown): value is DeliveryJobData {
  if (typeof value !== 'object' || value === null) return false;
  const data = value as Record<string, unknown>;
  return (
    isPositiveId(data.deliveryId) &&
    isPositiveId(data.outboxEventId) &&
    typeof data.generation === 'number' &&
    Number.isInteger(data.generation) &&
    data.generation > 0
  );
}

export interface DeliveryWorkerOptions {
  queueName: string;
  connection: Redis;
  concurrency: number;
  logger: DeliveryLogger;
  handler: (data: DeliveryJobData) => Promise<string>;
}

/**
 * BullMQ consumer. The handler result is informational; a thrown error (e.g. database down)
 * fails the job without BullMQ retries and the reconciler recovers the delivery from the DB.
 */
export function createDeliveryWorker(options: DeliveryWorkerOptions): Worker<DeliveryJobData> {
  const worker = new Worker<DeliveryJobData, string>(
    options.queueName,
    async (job: Job<DeliveryJobData>) => {
      if (!isDeliveryJobData(job.data)) {
        options.logger.error({ jobId: job.id }, 'invalid delivery job payload discarded');
        return 'invalid_job';
      }
      return options.handler(job.data);
    },
    { connection: options.connection, concurrency: options.concurrency, autorun: true },
  );
  worker.on('failed', (job, err) => {
    options.logger.error(
      { jobId: job?.id, deliveryId: job?.data.deliveryId, err: err.message },
      'delivery job failed',
    );
  });
  worker.on('error', (err) => {
    options.logger.warn({ err: err.message }, 'delivery worker connection error');
  });
  return worker;
}
