import { describe, expect, it } from 'vitest';
import { dispatchJobId } from '../../../src/contracts/jobs.js';
import { TIMING } from '../support/env.js';
import { useE2eSystem } from '../support/lifecycle.js';
import { emailRequest, uniqueRecipient } from '../support/payloads.js';
import type { SeededTenant } from '../support/seed.js';
import type { E2eSystem } from '../support/system.js';
import { delay, waitFor } from '../support/wait-for.js';

/**
 * Scenario 3 — crash after the DB commit, after enqueue and before the outbox ack: no request is
 * lost and duplicate jobs for already resolved deliveries do not produce new attempts.
 *
 * Fault injection: the dispatcher is SIGKILLed for real, and the precise windows are reproduced
 * by putting the outbox row in the state a crashed dispatcher leaves behind (claimed lease that
 * expired) and/or by publishing the BullMQ job the crashed dispatcher had already enqueued.
 */
describe('scenario 3: dispatcher crash windows', () => {
  const system = useE2eSystem(5);
  const timeout = TIMING.startupMs * 3 + TIMING.recoveryMs + TIMING.settleMs * 2;

  async function seed(sys: E2eSystem): Promise<SeededTenant> {
    return sys.seedTenant({
      providerInstances: [sys.fakeSmtpInstance()],
      routingPolicies: [sys.policy(['fake-smtp'])],
    });
  }

  async function expectSingleSend(sys: E2eSystem, id: string, recipient: string) {
    await delay(TIMING.settleMs);
    expect(sys.smtp.sendAttempts(recipient)).toBe(1);
    expect(sys.smtp.acceptedMessages(recipient)).toHaveLength(1);
    const attempts = await sys.attempts(id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe('accepted');
  }

  it(
    'S3.1 crash after commit, before publication: the outbox event is published on restart',
    async () => {
      const sys = system();
      const tenant = await seed(sys);
      await sys.startApi();
      await sys.startWorker();
      const recipient = uniqueRecipient('s03-commit');
      const id = await sys.submit(tenant, emailRequest(recipient));

      // Committed with its outbox intent, nothing published while no dispatcher runs.
      const [event] = await sys.outbox(id);
      expect(event?.status).toBe('pending');
      expect((await sys.delivery(id))?.submission_status).toBe('pending');

      await sys.startDispatcher();
      await sys.waitForStatus(tenant, id, ['accepted']);
      await expectSingleSend(sys, id, recipient);
    },
    timeout,
  );

  it(
    'S3.2 crash after claiming the outbox row, before enqueue: the expired claim is recovered',
    async () => {
      const sys = system();
      const tenant = await seed(sys);
      await sys.startApi();
      await sys.startWorker();
      const recipient = uniqueRecipient('s03-claimed');
      const id = await sys.submit(tenant, emailRequest(recipient));

      // State left by a dispatcher killed right after its claim transaction committed.
      await sys.db.query(
        `update outbox_events
       set status = 'publishing', lease_token = gen_random_uuid(),
           lease_expires_at = now() - interval '1 second', dispatch_count = dispatch_count + 1
       where delivery_id = (select id from deliveries where notification_id = ?)`,
        [id],
      );

      await sys.startDispatcher();
      await sys.waitForStatus(tenant, id, ['accepted'], TIMING.recoveryMs);
      await expectSingleSend(sys, id, recipient);
    },
    timeout,
  );

  it(
    'S3.3 crash after enqueue, before the outbox ack: the re-publication is a harmless duplicate',
    async () => {
      const sys = system();
      const tenant = await seed(sys);
      await sys.startApi();
      await sys.startWorker();
      const recipient = uniqueRecipient('s03-enqueued');
      const id = await sys.submit(tenant, emailRequest(recipient));
      const delivery = await sys.delivery(id);
      const [event] = await sys.outbox(id);
      if (delivery === undefined || event === undefined) throw new Error('missing rows');

      // The dead dispatcher had claimed the row and enqueued the job, but never acked.
      await sys.db.query(
        `update outbox_events
       set status = 'publishing', lease_token = gen_random_uuid(),
           lease_expires_at = now() - interval '1 second', dispatch_count = 1
       where id = ?`,
        [event.id],
      );
      const firstJob = dispatchJobId(event.id, 1);
      await sys.queue.publishDispatch(firstJob, {
        deliveryId: delivery.id,
        generation: delivery.generation,
        outboxEventId: event.id,
      });
      await sys.waitForStatus(tenant, id, ['accepted']);
      await sys.queue.waitForJobFinished(firstJob);

      // Restarted dispatcher recovers the un-acked event (re-publishing it or acking it after
      // checking the delivery); either way the worker must not send again.
      await sys.startDispatcher();
      await waitFor(
        async () => {
          const [row] = await sys.outbox(id);
          return row?.status === 'published' ? row : undefined;
        },
        {
          timeoutMs: TIMING.recoveryMs,
          description: 'outbox event re-published and acked',
          diagnostics: () => sys.diagnostics(),
        },
      );
      await waitFor(async () => (await sys.queue.pendingJobCount()) === 0, {
        timeoutMs: TIMING.deliveryMs,
        description: 'duplicate job consumed',
      });
      await expectSingleSend(sys, id, recipient);
      expect((await sys.view(tenant, id)).submissionStatus).toBe('accepted');
    },
    timeout,
  );

  it(
    'S3.4 duplicate jobs for an already accepted delivery create no new attempt',
    async () => {
      const sys = system();
      const tenant = await seed(sys);
      await sys.startAll();
      const recipient = uniqueRecipient('s03-dup');
      const id = await sys.submit(tenant, emailRequest(recipient));
      await sys.waitForStatus(tenant, id, ['accepted']);
      const delivery = await sys.delivery(id);
      const [event] = await sys.outbox(id);
      if (delivery === undefined || event === undefined) throw new Error('missing rows');

      const duplicates = [dispatchJobId(event.id, 90), dispatchJobId(event.id, 91)];
      for (const jobId of duplicates) {
        await sys.queue.publishDispatch(jobId, {
          deliveryId: delivery.id,
          generation: delivery.generation,
          outboxEventId: event.id,
        });
      }
      for (const jobId of duplicates) await sys.queue.waitForJobFinished(jobId);
      await expectSingleSend(sys, id, recipient);
      const after = await sys.delivery(id);
      expect(after?.submission_status).toBe('accepted');
      expect(after?.generation).toBe(delivery.generation);
    },
    timeout,
  );

  it(
    'S3.5 dispatcher SIGKILLed while publishing a burst: nothing lost, nothing sent twice',
    async () => {
      const sys = system();
      const tenant = await seed(sys);
      await sys.startApi();
      await sys.startWorker();
      const recipients = Array.from({ length: 20 }, () => uniqueRecipient('s03-burst'));
      const ids = await Promise.all(recipients.map((r) => sys.submit(tenant, emailRequest(r))));

      const dispatcher = await sys.startDispatcher();
      await waitFor(
        async () =>
          (await sys.db.count(
            `select count(*) from outbox_events where tenant_id = ? and status <> 'pending'`,
            [tenant.tenantId],
          )) > 0,
        { timeoutMs: TIMING.deliveryMs, intervalMs: 20, description: 'first outbox claim' },
      );
      await dispatcher.kill();

      await sys.startDispatcher('dispatcher-restarted');
      for (const id of ids) await sys.waitForStatus(tenant, id, ['accepted'], TIMING.recoveryMs);
      await delay(TIMING.settleMs);
      for (const [index, recipient] of recipients.entries()) {
        expect(sys.smtp.sendAttempts(recipient), recipient).toBe(1);
        expect(await sys.attempts(ids[index] ?? '')).toHaveLength(1);
      }
    },
    timeout,
  );
});
