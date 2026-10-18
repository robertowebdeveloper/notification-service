import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { signSvixPayload } from '../../../src/infrastructure/providers/email/resend-webhook.js';
import type { ProviderInstanceRecord } from '../../../src/application/ports/lookup-repositories.js';
import { buildTestApi, instance, nextId, WEBHOOK_SECRET, type TestApi } from './support/fakes.js';

function signedRequest(body: string, id = `msg_${randomUUID()}`, secret = WEBHOOK_SECRET) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    'content-type': 'application/json',
    'svix-id': id,
    'svix-timestamp': timestamp,
    'svix-signature': `v1,${signSvixPayload(secret, id, timestamp, Buffer.from(body))}`,
  };
}

const EVENT = JSON.stringify({
  type: 'email.delivered',
  created_at: '2026-10-18T10:00:00.000Z',
  data: { email_id: 'em_123', to: ['customer@example.org'], subject: 'secret subject' },
});

describe('provider webhooks', () => {
  let api: TestApi;
  let resend: ProviderInstanceRecord;

  beforeEach(async () => {
    api = await buildTestApi();
    const tenantId = nextId();
    resend = instance(tenantId, {
      providerType: 'resend',
      name: 'resend-main',
      config: {},
      secretRef: 'env:RESEND_TEST',
    });
    api.providerConfig.instances.push(resend);
  });

  function send(
    body: string,
    headers: Record<string, string>,
    url = `/v1/webhooks/resend/${resend.id}`,
  ) {
    return api.app.inject({ method: 'POST', url, headers, payload: body });
  }

  it('verifies the raw body, records the event with the instance tenant and returns 200', async () => {
    // Whitespace must be preserved byte-for-byte for the signature to match.
    const body = EVENT.replace('{', '{  ');
    const res = await send(body, signedRequest(body));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: 1, duplicates: 0 });
    expect(api.providerEvents.events).toHaveLength(1);
    expect(api.providerEvents.events[0]).toMatchObject({
      tenantId: resend.tenantId,
      providerInstanceId: resend.id,
      externalMessageId: 'em_123',
      type: 'delivered',
    });
  });

  it('answers 200 for a duplicate delivery of the same event', async () => {
    const headers = signedRequest(EVENT, 'msg_dup');
    expect((await send(EVENT, headers)).statusCode).toBe(200);
    const again = await send(EVENT, headers);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ received: 1, duplicates: 1 });
    expect(api.providerEvents.events).toHaveLength(1);
  });

  it('rejects an invalid signature with 401 without details', async () => {
    const wrong = 'whsec_' + Buffer.from('another-secret').toString('base64');
    const res = await send(EVENT, signedRequest(EVENT, 'msg_x', wrong));
    expect(res.statusCode).toBe(401);
    expect(res.json<{ code: string; details?: unknown }>()).toMatchObject({ code: 'unauthorized' });
    expect(res.json<{ details?: unknown }>().details).toBeUndefined();
    expect(api.providerEvents.events).toHaveLength(0);
  });

  it('rejects a tampered body with 401', async () => {
    const headers = signedRequest(EVENT);
    const res = await send(EVENT.replace('em_123', 'em_999'), headers);
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 for unknown instances, provider types or adapters without webhooks', async () => {
    const headers = signedRequest(EVENT);
    expect((await send(EVENT, headers, `/v1/webhooks/resend/${nextId()}`)).statusCode).toBe(404);
    expect((await send(EVENT, headers, `/v1/webhooks/unknown/${resend.id}`)).statusCode).toBe(404);
    const smtp = instance(resend.tenantId);
    api.providerConfig.instances.push(smtp);
    expect((await send(EVENT, headers, `/v1/webhooks/smtp/${smtp.id}`)).statusCode).toBe(404);
  });

  it('returns 503 when the instance secrets cannot be resolved', async () => {
    resend.secretRef = 'env:MISSING_PREFIX';
    const res = await send(EVENT, signedRequest(EVENT));
    expect(res.statusCode).toBe(503);
  });

  it('accepts non-JSON content types as raw bytes and enforces the body limit', async () => {
    const headers = { ...signedRequest(EVENT), 'content-type': 'text/plain' };
    expect((await send(EVENT, headers)).statusCode).toBe(200);
    const huge = 'x'.repeat(300 * 1024);
    expect((await send(huge, signedRequest(huge))).statusCode).toBe(413);
  });

  it('rate limits webhook calls per instance', async () => {
    api.rateLimiter.decision = { allowed: false, retryAfterMs: 500 };
    const res = await send(EVENT, signedRequest(EVENT));
    expect(res.statusCode).toBe(429);
    expect(api.rateLimiter.keys).toEqual([`webhook:${resend.id}`]);
  });
});
