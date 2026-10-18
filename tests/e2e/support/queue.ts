import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { QUEUE_NAMES, type DeliveryJobData } from '../../../src/contracts/jobs.js';
import { TIMING } from './env.js';
import { waitFor } from './wait-for.js';

/**
 * Direct access to the per-file Valkey DB index, used for fault injection only: flushing the
 * queue (Valkey data loss) and publishing duplicate dispatch jobs exactly as the dispatcher would.
 * Assumes the default BullMQ prefix (`bull`) and the frozen queue name from src/contracts/jobs.ts.
 */
export class E2eQueue {
  readonly redis: Redis;
  readonly email: Queue<DeliveryJobData>;
  private readonly queueConnection: Redis;

  constructor(readonly url: string) {
    this.redis = new Redis(url, { maxRetriesPerRequest: null });
    this.queueConnection = new Redis(url, { maxRetriesPerRequest: null });
    this.email = new Queue<DeliveryJobData>(QUEUE_NAMES.email, {
      connection: this.queueConnection,
    });
  }

  /** Simulates the loss of every queue key (Valkey restarted without persisted data). */
  async flush(): Promise<void> {
    await this.redis.flushdb();
  }

  async keyCount(): Promise<number> {
    return this.redis.dbsize();
  }

  async pendingJobCount(): Promise<number> {
    const counts = await this.email.getJobCounts('waiting', 'prioritized', 'delayed', 'active');
    return Object.values(counts).reduce((sum, n) => sum + n, 0);
  }

  /** Publishes a dispatch job with an explicit id (duplicate publication / lost ack). */
  async publishDispatch(jobId: string, data: DeliveryJobData): Promise<void> {
    await this.email.add('dispatch', data, { jobId, attempts: 1 });
  }

  /** Waits until the job is completed, failed or already removed after completion. */
  async waitForJobFinished(jobId: string, timeoutMs: number = TIMING.deliveryMs): Promise<string> {
    return waitFor(
      async () => {
        const job = await this.email.getJob(jobId);
        if (job === undefined) return 'removed';
        const state = await job.getState();
        return state === 'completed' || state === 'failed' ? state : undefined;
      },
      { timeoutMs, description: `job ${jobId} to finish` },
    );
  }

  async close(): Promise<void> {
    await this.email.close();
    this.queueConnection.disconnect();
    this.redis.disconnect();
  }
}
