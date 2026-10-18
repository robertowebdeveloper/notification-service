import { randomUUID } from 'node:crypto';
import type { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildHarness,
  closeOrm,
  createRequest,
  migratedOrm,
  queryRows,
  setupTenant,
  type ApiHarness,
  type TenantSetup,
} from './support.js';

type Outcome = 'rejected' | 'unknown' | 'accepted';

describe('manual retry against PostgreSQL', () => {
  let orm: MikroORM;
  let h: ApiHarness;
  let tenant: TenantSetup;

  beforeAll(async () => {
    orm = await migratedOrm();
    h = await buildHarness(orm);
    tenant = await setupTenant(orm);
  });

  afterAll(async () => {
    await h.app.close();
    await closeOrm();
  });

  const allKey = (t: TenantSetup) => t.keys.all ?? '';

  /** Creates a notification and forces its delivery into `status` with the given attempts. */
  async function notificationIn(status: string, outcomes: Outcome[]): Promise<string> {
    const res = await createRequest(h.app, allKey(tenant), `n-${randomUUID()}`);
    const id = res.json<{ id: string }>().id;
    const rows = await queryRows(orm, `select id from deliveries where notification_id = ?`, [id]);
    const deliveryId = String(rows[0]?.id);
    for (const [index, outcome] of outcomes.entries()) {
      await queryRows(
        orm,
        `insert into delivery_attempts
           (tenant_id, delivery_id, attempt_number, generation, provider_instance_id,
            provider_instance_revision, provider_idempotency_key, outcome, finished_at, error_code)
         values (?, ?, ?, ?, ?, 1, ?, ?, now(), ?)`,
        [
          tenant.tenantId,
          deliveryId,
          index + 1,
          index + 1,
          tenant.instanceIds.smtp,
          `pk-${randomUUID()}`,
          outcome,
          outcome === 'rejected' ? 'recipient_rejected' : null,
        ],
      );
    }
    await queryRows(
      orm,
      `update deliveries set submission_status = ?, attempts_used = ?, generation = ?,
              last_error_code = 'recipient_rejected', last_error_message = 'rejected'
       where id = ?`,
      [status, outcomes.length, Math.max(1, outcomes.length), deliveryId],
    );
    return id;
  }

  function retry(id: string, idempotencyKey: string, key = allKey(tenant)) {
    return h.app.inject({
      method: 'POST',
      url: `/v1/notifications/${id}/retry`,
      headers: { authorization: `Bearer ${key}`, 'idempotency-key': idempotencyKey },
    });
  }

  it('retries a failed delivery whose attempts were all rejected, with a new budget', async () => {
    const id = await notificationIn('failed', ['rejected', 'rejected', 'rejected']);
    const res = await retry(id, 'r-1');
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ id, submissionStatus: 'retry_wait', generation: 4 });

    const delivery = await queryRows(
      orm,
      `select d.submission_status, d.generation, d.max_attempts, d.attempts_used,
              (select count(*)::int from outbox_events o
               where o.delivery_id = d.id and o.generation = 4 and o.status = 'pending') as outbox
       from deliveries d where d.notification_id = ?`,
      [id],
    );
    expect(delivery[0]).toEqual({
      submission_status: 'retry_wait',
      generation: 4,
      max_attempts: 6,
      attempts_used: 3,
      outbox: 1,
    });
    const audit = await queryRows(
      orm,
      `select actor, details from audit_events
       where tenant_id = ? and operation = 'notification.manual_retry' and resource_id = ?`,
      [tenant.tenantId, id],
    );
    expect(audit).toHaveLength(1);
    expect(String(audit[0]?.actor)).toMatch(/^api_key:/);
    expect(audit[0]?.details).toMatchObject({
      idempotencyKey: 'r-1',
      generation: 4,
      grantedAttempts: 3,
    });

    const replay = await retry(id, 'r-1');
    expect(replay.statusCode).toBe(202);
    expect(replay.json()).toEqual({ id, submissionStatus: 'retry_wait', generation: 4 });
    const outbox = await queryRows(
      orm,
      `select count(*)::int as count from outbox_events o join deliveries d on d.id = o.delivery_id
       where d.notification_id = ?`,
      [id],
    );
    expect(outbox[0]?.count).toBe(2);

    const otherKey = await retry(id, 'r-2');
    expect(otherKey.statusCode).toBe(409);
    expect(otherKey.json()).toMatchObject({
      code: 'conflict',
      details: { submissionStatus: 'retry_wait' },
    });
  });

  it.each([
    ['failed with an unknown attempt', 'failed', ['rejected', 'unknown']],
    ['accepted', 'accepted', ['accepted']],
    ['unknown', 'unknown', ['unknown']],
    ['suppressed', 'suppressed', []],
    ['pending', 'pending', []],
  ] as const)('refuses %s with 409', async (_name, status, outcomes) => {
    const id = await notificationIn(status, [...outcomes]);
    const res = await retry(id, `k-${randomUUID()}`);
    expect(res.statusCode).toBe(409);
    expect(res.json<{ code: string }>().code).toBe('conflict');
  });

  it('denies retries across tenants with 404', async () => {
    const id = await notificationIn('failed', ['rejected']);
    const intruder = await setupTenant(orm);
    const res = await retry(id, 'x-1', allKey(intruder));
    expect(res.statusCode).toBe(404);
    const delivery = await queryRows(
      orm,
      `select submission_status from deliveries where notification_id = ?`,
      [id],
    );
    expect(delivery[0]?.submission_status).toBe('failed');
  });

  it('schedules once for concurrent requests with the same key', async () => {
    const id = await notificationIn('failed', ['rejected']);
    const responses = await Promise.all(Array.from({ length: 5 }, () => retry(id, 'same')));
    expect(responses.map((r) => r.statusCode)).toEqual(Array(5).fill(202));
    expect(new Set(responses.map((r) => r.json<{ generation: number }>().generation))).toEqual(
      new Set([2]),
    );
    const audit = await queryRows(
      orm,
      `select count(*)::int as count from audit_events where operation = 'notification.manual_retry' and resource_id = ?`,
      [id],
    );
    expect(audit[0]?.count).toBe(1);
  });

  it('requires the retry scope and an Idempotency-Key', async () => {
    const id = await notificationIn('failed', ['rejected']);
    expect((await retry(id, 'scope', tenant.keys.write)).statusCode).toBe(403);
    const noKey = await h.app.inject({
      method: 'POST',
      url: `/v1/notifications/${id}/retry`,
      headers: { authorization: `Bearer ${allKey(tenant)}` },
    });
    expect(noKey.statusCode).toBe(400);
  });
});
