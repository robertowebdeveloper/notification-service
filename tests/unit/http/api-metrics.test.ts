import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ProviderInstanceRecord } from '../../../src/application/ports/lookup-repositories.js';
import { signSvixPayload } from '../../../src/infrastructure/providers/email/resend-webhook.js';
import {
  buildTestApi,
  emailBody,
  instance,
  WEBHOOK_SECRET,
  type TestApi,
} from './support/fakes.js';

describe('API metrics', () => {
  let api: TestApi;
  let tenantId: string;
  let key: string;

  beforeEach(async () => {
    api = await buildTestApi();
    tenantId = randomUUID();
    key = api.apiKeys.add(tenantId, ['notifications:write', 'notifications:retry']);
    api.providerConfig.addPolicy(tenantId, [instance(tenantId)]);
  });

  function post(body: unknown, headers: Record<string, string> = {}) {
    return api.app.inject({
      method: 'POST',
      url: '/v1/notifications',
      headers: { authorization: `Bearer ${key}`, 'idempotency-key': 'k-1', ...headers },
      payload: body as Record<string, unknown>,
    });
  }

  it('records accepted submissions, including idempotent replays', async () => {
    expect((await post(emailBody())).statusCode).toBe(202);
    expect((await post(emailBody())).statusCode).toBe(202);
    expect(api.metrics.of('apiRequestAccepted')).toEqual([
      ['create_notification'],
      ['create_notification'],
    ]);
    expect(api.metrics.of('apiRequestRejected')).toEqual([]);
  });

  it('records rejections with the response error code, including auth and validation', async () => {
    await post(emailBody());
    await post(emailBody({ metadata: { other: true } })); // same key, other payload
    await post(emailBody(), { authorization: 'Bearer nope' });
    await post({ channel: 'email' }, { 'idempotency-key': 'k-2' });
    await post(
      {
        channel: 'sms',
        routingKey: 'transactional',
        recipient: { phoneNumber: '+393331234567' },
        content: { text: 'hi' },
      },
      { 'idempotency-key': 'k-3' },
    );

    expect(api.metrics.of('apiRequestRejected')).toEqual([
      ['create_notification', 'idempotency_conflict'],
      ['create_notification', 'unauthorized'],
      ['create_notification', 'validation_error'],
      ['create_notification', 'channel_not_enabled'],
    ]);
  });

  it('records manual retries under their own operation', async () => {
    const created = (await post(emailBody())).json<{ id: string }>();
    const retry = (id: string) =>
      api.app.inject({
        method: 'POST',
        url: `/v1/notifications/${id}/retry`,
        headers: { authorization: `Bearer ${key}`, 'idempotency-key': 'retry-1' },
      });
    expect((await retry(created.id)).statusCode).toBe(202);
    api.manualRetries.next = { kind: 'not_retryable', submissionStatus: 'accepted' };
    expect((await retry(created.id)).statusCode).toBe(409);

    expect(api.metrics.of('apiRequestAccepted')).toContainEqual(['retry_notification']);
    expect(api.metrics.of('apiRequestRejected')).toEqual([['retry_notification', 'conflict']]);
  });

  it('does not record read routes', async () => {
    const reader = api.apiKeys.add(tenantId, ['notifications:read']);
    await api.app.inject({
      method: 'GET',
      url: '/v1/notifications',
      headers: { authorization: `Bearer ${reader}` },
    });
    expect(api.metrics.calls).toEqual([]);
  });
});

describe('webhook metrics', () => {
  let api: TestApi;
  let resend: ProviderInstanceRecord;
  const body = JSON.stringify({
    type: 'email.delivered',
    created_at: '2026-10-18T10:00:00.000Z',
    data: { email_id: 'em_123' },
  });

  function headers(secret = WEBHOOK_SECRET) {
    const id = `msg_${randomUUID()}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    return {
      'content-type': 'application/json',
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': `v1,${signSvixPayload(secret, id, timestamp, Buffer.from(body))}`,
    };
  }

  function send(url: string, h = headers()) {
    return api.app.inject({ method: 'POST', url, headers: h, payload: body });
  }

  beforeEach(async () => {
    api = await buildTestApi();
    resend = instance(randomUUID(), {
      providerType: 'resend',
      name: 'resend-main',
      config: {},
      secretRef: 'env:RESEND_TEST',
    });
    api.providerConfig.instances.push(resend);
  });

  it('records stored webhooks and invalid ones by reason', async () => {
    expect((await send(`/v1/webhooks/resend/${resend.id}`)).statusCode).toBe(200);
    const forged = headers('whsec_' + Buffer.from('wrong-secret').toString('base64'));
    expect((await send(`/v1/webhooks/resend/${resend.id}`, forged)).statusCode).toBe(401);
    expect((await send(`/v1/webhooks/resend/${randomUUID()}`)).statusCode).toBe(404);
    resend.secretRef = 'env:MISSING_PREFIX';
    expect((await send(`/v1/webhooks/resend/${resend.id}`)).statusCode).toBe(503);

    expect(api.metrics.of('webhookReceived')).toEqual([['resend']]);
    expect(api.metrics.of('webhookInvalid')).toEqual([
      ['resend', 'invalid_signature'],
      ['resend', 'unknown_instance'],
      ['resend', 'unavailable'],
    ]);
  });

  it('never records unregistered provider types (unbounded path segment)', async () => {
    expect((await send(`/v1/webhooks/attacker-type/${resend.id}`)).statusCode).toBe(404);
    expect(api.metrics.calls).toEqual([]);
  });
});
