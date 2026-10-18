import { describe, expect, it } from 'vitest';
import { TIMING } from '../support/env.js';
import { useE2eSystem } from '../support/lifecycle.js';
import { emailRequest, uniqueRecipient } from '../support/payloads.js';
import { delay, waitFor } from '../support/wait-for.js';

/**
 * Scenario 7 — Valkey loss/restore rebuilds pending work from PostgreSQL without resending
 * accepted deliveries.
 *
 * Fault injection: FLUSHDB of this file's dedicated Valkey DB index while jobs are queued and not
 * yet consumed (equivalent to Valkey restarting without its data). The shared Valkey container is
 * never restarted, so other suites and the local Compose stack are unaffected.
 */
describe('scenario 7: Valkey data loss', () => {
  const system = useE2eSystem(9);
  // Lost jobs are re-armed only after the reconciler's "lost publication" age, plus a cycle.
  const rebuildMs = Math.max(TIMING.recoveryMs, TIMING.lostPublicationMs + 60_000);

  it(
    'S7.1 queued jobs lost in Valkey are rebuilt from the DB; accepted deliveries are not resent',
    async () => {
      const sys = system();
      const tenant = await sys.seedTenant({
        providerInstances: [sys.fakeSmtpInstance()],
        routingPolicies: [sys.policy(['fake-smtp'])],
      });
      const { worker } = await sys.startAll();

      const before = Array.from({ length: 3 }, () => uniqueRecipient('s07-before'));
      const beforeIds = await Promise.all(before.map((r) => sys.submit(tenant, emailRequest(r))));
      for (const id of beforeIds) await sys.waitForStatus(tenant, id, ['accepted']);

      await worker.stop('SIGTERM');
      const lost = Array.from({ length: 3 }, () => uniqueRecipient('s07-lost'));
      const lostIds = await Promise.all(lost.map((r) => sys.submit(tenant, emailRequest(r))));
      // The dispatcher publishes and acks them: the jobs now exist only in Valkey.
      await waitFor(
        async () => {
          for (const id of lostIds) {
            const [event] = await sys.outbox(id);
            if (event?.status !== 'published') return false;
          }
          return (await sys.queue.pendingJobCount()) >= lostIds.length;
        },
        {
          timeoutMs: TIMING.deliveryMs,
          description: 'jobs published and waiting in Valkey',
          diagnostics: () => sys.diagnostics(),
        },
      );

      await sys.queue.flush();
      expect(await sys.queue.pendingJobCount()).toBe(0);

      await sys.startWorker('worker-after-loss');
      for (const id of lostIds) {
        await sys.waitForStatus(tenant, id, ['accepted'], rebuildMs);
      }
      await delay(TIMING.settleMs);
      for (const recipient of [...before, ...lost]) {
        expect(sys.smtp.sendAttempts(recipient), recipient).toBe(1);
      }
      for (const id of [...beforeIds, ...lostIds]) expect(await sys.attempts(id)).toHaveLength(1);
    },
    TIMING.startupMs * 2 + rebuildMs + TIMING.deliveryMs * 2 + TIMING.settleMs * 2,
  );

  it(
    'S7.2 Valkey flushed under running processes: new and pending work still completes once',
    async () => {
      const sys = system();
      const tenant = await sys.seedTenant({
        providerInstances: [sys.fakeSmtpInstance()],
        routingPolicies: [sys.policy(['fake-smtp'])],
      });
      await sys.startAll();
      const first = uniqueRecipient('s07-running');
      const firstId = await sys.submit(tenant, emailRequest(first));
      await sys.waitForStatus(tenant, firstId, ['accepted']);

      await sys.queue.flush();
      const second = uniqueRecipient('s07-after-flush');
      const secondId = await sys.submit(tenant, emailRequest(second));
      await sys.waitForStatus(tenant, secondId, ['accepted'], TIMING.recoveryMs);
      await delay(TIMING.settleMs);
      expect(sys.smtp.sendAttempts(first)).toBe(1);
      expect(sys.smtp.sendAttempts(second)).toBe(1);
    },
    TIMING.startupMs * 2 + TIMING.recoveryMs + TIMING.deliveryMs + TIMING.settleMs * 2,
  );
});
