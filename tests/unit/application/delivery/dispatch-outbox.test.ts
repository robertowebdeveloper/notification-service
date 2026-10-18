import { describe, expect, it } from 'vitest';
import { DispatchOutbox } from '../../../../src/application/delivery/dispatch-outbox.js';
import {
  QueuePublishError,
  silentLogger,
  type DeliveryJobPublisher,
} from '../../../../src/application/delivery/ports.js';
import type {
  ClaimedOutboxEvent,
  LostPublicationCandidate,
  OutboxRepository,
} from '../../../../src/application/ports/repositories.js';
import type { Channel } from '../../../../src/contracts/channels.js';
import type { DeliveryJobData } from '../../../../src/contracts/jobs.js';
import { RecordingMetrics } from '../../observability/recording-metrics.js';

function event(id: string, dispatchCount = 1, channel: Channel = 'email'): ClaimedOutboxEvent {
  return {
    id,
    deliveryId: `delivery-${id}`,
    generation: 1,
    channel,
    dispatchCount,
    leaseToken: `lease-${id}`,
  };
}

class FakeOutbox implements OutboxRepository {
  published: string[] = [];
  released: { id: string; error: string; retryAfterMs: number }[] = [];
  constructor(private readonly events: ClaimedOutboxEvent[]) {}
  claimAvailable(): Promise<ClaimedOutboxEvent[]> {
    return Promise.resolve(this.events.splice(0));
  }
  markPublished(id: string): Promise<boolean> {
    this.published.push(id);
    return Promise.resolve(true);
  }
  releaseAfterError(
    id: string,
    _lease: string,
    error: string,
    retryAfterMs: number,
  ): Promise<boolean> {
    this.released.push({ id, error, retryAfterMs });
    return Promise.resolve(true);
  }
  findLostPublications(): Promise<LostPublicationCandidate[]> {
    return Promise.resolve([]);
  }
  rearmPublications(): Promise<number> {
    return Promise.resolve(0);
  }
}

class FakePublisher implements DeliveryJobPublisher {
  calls: { channel: Channel; jobId: string; data: DeliveryJobData }[] = [];
  constructor(
    private readonly behaviour: (jobId: string) => Promise<void> = () => Promise.resolve(),
  ) {}
  publish(channel: Channel, jobId: string, data: DeliveryJobData): Promise<void> {
    this.calls.push({ channel, jobId, data });
    return this.behaviour(jobId);
  }
}

describe('DispatchOutbox', () => {
  it('publishes references only with the deterministic job id, then acks', async () => {
    const outbox = new FakeOutbox([event('e1', 3)]);
    const publisher = new FakePublisher();
    const dispatcher = new DispatchOutbox({
      outbox,
      publisher,
      logger: silentLogger,
    });

    const report = await dispatcher.runOnce();

    expect(report).toEqual({ claimed: 1, published: 1, released: 0, ackLost: 0, yielded: 0 });
    expect(publisher.calls).toEqual([
      {
        channel: 'email',
        jobId: 'dispatch-e1-3',
        data: { deliveryId: 'delivery-e1', generation: 1, outboxEventId: 'e1' },
      },
    ]);
    expect(outbox.published).toEqual(['e1']);
  });

  it('does not ack on queue failure and fails the rest of the batch fast', async () => {
    const outbox = new FakeOutbox([event('e1'), event('e2'), event('e3')]);
    const publisher = new FakePublisher(() =>
      Promise.reject(new QueuePublishError('publish_timeout', 'timeout')),
    );
    const dispatcher = new DispatchOutbox({
      outbox,
      publisher,
      logger: silentLogger,
      options: { retryBaseMs: 1_000 },
    });

    const report = await dispatcher.runOnce();

    expect(publisher.calls).toHaveLength(1);
    expect(outbox.published).toEqual([]);
    expect(report.released).toBe(3);
    expect(outbox.released.map((r) => r.id)).toEqual(['e1', 'e2', 'e3']);
    expect(outbox.released[0]?.error).toContain('publish_timeout');
    expect(outbox.released[0]?.retryAfterMs).toBe(1_000);
  });

  it('backs off re-publication with the dispatch count, bounded', async () => {
    const outbox = new FakeOutbox([event('e1', 4), event('e2', 50)]);
    const publisher = new FakePublisher(() =>
      Promise.reject(new QueuePublishError('queue_unavailable', 'down')),
    );
    const dispatcher = new DispatchOutbox({
      outbox,
      publisher,
      logger: silentLogger,
      options: { retryBaseMs: 1_000, retryMaxMs: 30_000 },
    });
    await dispatcher.runOnce();
    expect(outbox.released.map((r) => r.retryAfterMs)).toEqual([8_000, 30_000]);
  });

  it('parks events of channels without a queue without blocking the others', async () => {
    const outbox = new FakeOutbox([event('sms1', 1, 'sms'), event('e1')]);
    const publisher = new FakePublisher((jobId) =>
      jobId.startsWith('dispatch-sms1')
        ? Promise.reject(new QueuePublishError('no_queue', 'none'))
        : Promise.resolve(),
    );
    const dispatcher = new DispatchOutbox({
      outbox,
      publisher,
      logger: silentLogger,
      options: { unroutableRetryMs: 3600_000 },
    });
    const report = await dispatcher.runOnce();
    expect(report).toMatchObject({ published: 1, released: 1 });
    expect(outbox.released[0]?.retryAfterMs).toBe(3600_000);
  });

  it('records published events and publication failures by reason', async () => {
    const metrics = new RecordingMetrics();
    const outbox = new FakeOutbox([event('ok'), event('down'), event('rest')]);
    const publisher = new FakePublisher((jobId) =>
      jobId.startsWith('dispatch-ok')
        ? Promise.resolve()
        : Promise.reject(new QueuePublishError('queue_unavailable', 'connection refused')),
    );
    const dispatcher = new DispatchOutbox({
      outbox,
      publisher,
      logger: silentLogger,
      metrics,
    });

    await dispatcher.runOnce();

    expect(metrics.of('outboxPublished')).toEqual([[1]]);
    expect(metrics.of('outboxPublishFailed')).toEqual([
      ['queue_unavailable', 1],
      ['queue_unavailable', 1],
    ]);
  });

  it('stops publishing when the outbox lease is nearly elapsed and releases the rest', async () => {
    const outbox = new FakeOutbox([event('e1'), event('e2'), event('e3'), event('e4')]);
    let clock = 0;
    // Each publication takes 10 s: with a 30 s lease and a 3 s publish timeout, the budget
    // (27 s) allows three publications to start (at 0, 10 and 20 s), not a fourth at 30 s.
    const publisher = new FakePublisher(() => {
      clock += 10_000;
      return Promise.resolve();
    });
    const dispatcher = new DispatchOutbox({
      outbox,
      publisher,
      logger: silentLogger,
      monotonicMs: () => clock,
      options: { leaseMs: 30_000, publishTimeoutMs: 3_000 },
    });

    const report = await dispatcher.runOnce();

    expect(report).toEqual({ claimed: 4, published: 3, released: 0, ackLost: 0, yielded: 1 });
    expect(outbox.published).toEqual(['e1', 'e2', 'e3']);
    expect(outbox.released).toEqual([
      {
        id: 'e4',
        error: expect.stringContaining('batch_time_budget') as unknown,
        retryAfterMs: 0,
      },
    ]);
  });
});
