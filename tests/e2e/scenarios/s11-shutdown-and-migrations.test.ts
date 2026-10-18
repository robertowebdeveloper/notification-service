import { describe, expect, it } from 'vitest';
import { E2eDatabase, dropDatabase } from '../support/database.js';
import { TIMING } from '../support/env.js';
import { useE2eSystem } from '../support/lifecycle.js';
import { emailRequest, uniqueRecipient } from '../support/payloads.js';
import { runToCompletion } from '../support/processes.js';
import { delay, waitFor } from '../support/wait-for.js';

/**
 * Scenario 11 — restarts and shutdown during a send keep a recoverable state; migrations work on
 * an empty database. (The Compose stack itself is not restarted: it is shared with development;
 * the same processes are stopped and restarted here with the signals Compose sends.)
 */
describe('scenario 11: graceful shutdown, restart and migrations', () => {
  const system = useE2eSystem(13);

  it('S11.1 migrations apply on an empty database and are idempotent', async () => {
    const name = 'notifications_e2e_13_fresh';
    await dropDatabase(name);
    const db = await E2eDatabase.open(name);
    try {
      const env = { ...system().env(), DATABASE_URL: db.url };
      const first = await runToCompletion('migrate', { name: 'migrate-fresh', env });
      expect(first.exit.code, first.output).toBe(0);
      const tables = await db.query<{ table_name: string }>(
        `select table_name from information_schema.tables where table_schema = 'public'`,
      );
      expect(tables.map((t) => t.table_name).sort()).toEqual(
        [
          'api_keys',
          'audit_events',
          'deliveries',
          'delivery_attempts',
          'mikro_orm_migrations',
          'notifications',
          'outbox_events',
          'provider_events',
          'provider_instances',
          'routing_policies',
          'routing_policy_providers',
          'suppressions',
          'tenants',
        ].sort(),
      );
      const applied = await db.count('select count(*) from mikro_orm_migrations');
      expect(applied).toBeGreaterThan(0);

      const second = await runToCompletion('migrate', { name: 'migrate-again', env });
      expect(second.exit.code, second.output).toBe(0);
      expect(await db.count('select count(*) from mikro_orm_migrations')).toBe(applied);
    } finally {
      await db.close();
      await dropDatabase(name);
    }
  }, 120_000);

  it(
    'S11.2 SIGTERM during a send waits for the in-flight call and commits its result',
    async () => {
      const sys = system();
      const tenant = await sys.seedTenant({
        providerInstances: [sys.fakeSmtpInstance('fake-smtp', { sendTimeoutMs: 60_000 })],
        routingPolicies: [sys.policy(['fake-smtp'])],
      });
      const { worker } = await sys.startAll();
      const recipient = uniqueRecipient('s11-graceful');
      sys.smtp.program(recipient, ['hold']);
      const id = await sys.submit(tenant, emailRequest(recipient));
      await waitFor(() => sys.smtp.potentialDeliveries(recipient) === 1, {
        timeoutMs: TIMING.deliveryMs,
        description: 'held message received',
        diagnostics: () => sys.diagnostics(),
      });

      worker.signal('SIGTERM');
      await delay(1_000);
      expect(worker.running).toBe(true);
      sys.smtp.release(recipient);
      const exit = await worker.exited;
      expect(exit.code, worker.tail()).toBe(0);

      const delivery = await sys.delivery(id);
      expect(delivery?.submission_status).toBe('accepted');
      const attempts = await sys.attempts(id);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.outcome).toBe('accepted');
    },
    TIMING.startupMs * 2 + TIMING.deliveryMs + TIMING.shutdownGraceMs + 10_000,
  );

  it(
    'S11.3 a send outlasting the grace period never reports fake success and is recovered as unknown',
    async () => {
      const sys = system();
      const tenant = await sys.seedTenant({
        providerInstances: [
          sys.fakeSmtpInstance('fake-smtp', { sendTimeoutMs: 120_000, socketTimeoutMs: 120_000 }),
        ],
        routingPolicies: [sys.policy(['fake-smtp'])],
      });
      await sys.startApi();
      await sys.startDispatcher();
      const worker = await sys.startWorker('worker-short-grace', { SHUTDOWN_GRACE_MS: '2000' });
      const recipient = uniqueRecipient('s11-grace-exceeded');
      sys.smtp.program(recipient, ['hold']);
      const id = await sys.submit(tenant, emailRequest(recipient));
      await waitFor(() => sys.smtp.potentialDeliveries(recipient) === 1, {
        timeoutMs: TIMING.deliveryMs,
        description: 'held message received',
        diagnostics: () => sys.diagnostics(),
      });

      await worker.stop('SIGTERM', 15_000);
      expect(worker.exitInfo?.signal).not.toBe('SIGKILL');
      const afterExit = await sys.delivery(id);
      expect(['sending', 'unknown']).toContain(afterExit?.submission_status);

      await sys.startWorker('worker-restarted');
      const view = await sys.waitForStatus(tenant, id, ['unknown'], TIMING.recoveryMs);
      expect(view.attempts).toHaveLength(1);
      await delay(TIMING.settleMs);
      expect(sys.smtp.sendAttempts(recipient)).toBe(1);
    },
    TIMING.startupMs * 3 + TIMING.recoveryMs + TIMING.settleMs + 20_000,
  );

  it(
    'S11.4 a full restart (SIGTERM all, start again) keeps state and keeps working',
    async () => {
      const sys = system();
      const tenant = await sys.seedTenant({
        providerInstances: [sys.fakeSmtpInstance()],
        routingPolicies: [sys.policy(['fake-smtp'])],
      });
      const first = await sys.startAll();
      const before = uniqueRecipient('s11-before');
      const beforeId = await sys.submit(tenant, emailRequest(before));
      await sys.waitForStatus(tenant, beforeId, ['accepted']);

      // Pending work submitted while workers are down must survive the restart.
      await first.worker.stop('SIGTERM');
      const pending = uniqueRecipient('s11-pending');
      const pendingId = await sys.submit(tenant, emailRequest(pending));
      for (const service of [first.api, first.dispatcher]) {
        const exit = await service.stop('SIGTERM');
        expect(exit.code, service.tail()).toBe(0);
      }

      await sys.startAll();
      await sys.waitForStatus(tenant, pendingId, ['accepted'], TIMING.recoveryMs);
      const after = uniqueRecipient('s11-after');
      const afterId = await sys.submit(tenant, emailRequest(after));
      await sys.waitForStatus(tenant, afterId, ['accepted']);
      await delay(TIMING.settleMs);
      for (const recipient of [before, pending, after]) {
        expect(sys.smtp.sendAttempts(recipient), recipient).toBe(1);
      }
    },
    TIMING.startupMs * 4 + TIMING.recoveryMs + TIMING.deliveryMs * 2 + TIMING.settleMs,
  );
});
