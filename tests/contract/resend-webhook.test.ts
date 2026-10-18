import { describe, expect, it } from 'vitest';
import {
  signSvixPayload,
  verifyAndParseResendWebhook,
} from '../../src/infrastructure/providers/email/resend-webhook.js';

const SECRET = `whsec_${Buffer.from('webhook-contract-key-0123456789').toString('base64')}`;
const OTHER_SECRET = `whsec_${Buffer.from('some-other-signing-key').toString('base64')}`;
const NOW = new Date('2026-10-17T12:00:00.000Z');
const NOW_SECONDS = String(Math.floor(NOW.getTime() / 1000));

function event(type: string, data: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      type,
      created_at: '2026-10-17T11:59:30.000Z',
      data: {
        email_id: 're_42',
        from: 'Sender <sender@example.test>',
        to: ['person@example.test'],
        subject: 'Private subject',
        ...data,
      },
    }),
  );
}

function signed(
  body: Buffer,
  options: { id?: string; timestamp?: string; secret?: string; signature?: string } = {},
) {
  const id = options.id ?? 'msg_2abc';
  const timestamp = options.timestamp ?? NOW_SECONDS;
  const signature =
    options.signature ?? `v1,${signSvixPayload(options.secret ?? SECRET, id, timestamp, body)}`;
  return { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': signature };
}

const verify = (body: Buffer, headers: Record<string, string | string[] | undefined>) =>
  verifyAndParseResendWebhook(body, headers, SECRET, { now: NOW });

describe('Resend webhook verification', () => {
  it('accepts a valid signature and normalizes the event', () => {
    const body = event('email.delivered');
    expect(verify(body, signed(body))).toEqual({
      ok: true,
      events: [
        {
          externalEventId: 'msg_2abc',
          externalMessageId: 're_42',
          type: 'delivered',
          occurredAt: new Date('2026-10-17T11:59:30.000Z'),
          payload: { providerEventType: 'email.delivered' },
        },
      ],
    });
  });

  it('accepts a header with several signatures when one of them matches', () => {
    const body = event('email.sent');
    const valid = signed(body)['svix-signature'];
    const headers = signed(body, {
      signature: `v1,${Buffer.alloc(32).toString('base64')} ${valid}`,
    });
    expect(verify(body, headers)).toMatchObject({ ok: true });
  });

  it('rejects a signature made with another secret', () => {
    const body = event('email.sent');
    expect(verify(body, signed(body, { secret: OTHER_SECRET }))).toEqual({
      ok: false,
      reason: 'invalid_signature',
    });
  });

  it('rejects a tampered body', () => {
    const body = event('email.sent');
    const headers = signed(body);
    expect(verify(event('email.delivered'), headers)).toEqual({
      ok: false,
      reason: 'invalid_signature',
    });
  });

  it('rejects missing signature headers', () => {
    const body = event('email.sent');
    expect(verify(body, { 'svix-id': 'msg_1', 'svix-timestamp': NOW_SECONDS })).toEqual({
      ok: false,
      reason: 'invalid_signature',
    });
  });

  it('rejects unsupported signature versions', () => {
    const body = event('email.sent');
    const valid = signed(body)['svix-signature'].slice(3);
    expect(verify(body, signed(body, { signature: `v2,${valid}` }))).toEqual({
      ok: false,
      reason: 'invalid_signature',
    });
  });

  it('rejects authentic events older than five minutes as stale', () => {
    const body = event('email.sent');
    const old = String(Number(NOW_SECONDS) - 301);
    expect(verify(body, signed(body, { timestamp: old }))).toEqual({
      ok: false,
      reason: 'stale_timestamp',
    });
  });

  it('rejects authentic events too far in the future as stale', () => {
    const body = event('email.sent');
    const future = String(Number(NOW_SECONDS) + 301);
    expect(verify(body, signed(body, { timestamp: future }))).toEqual({
      ok: false,
      reason: 'stale_timestamp',
    });
  });

  it('accepts events inside the tolerance window', () => {
    const body = event('email.sent');
    const recent = String(Number(NOW_SECONDS) - 299);
    expect(verify(body, signed(body, { timestamp: recent }))).toMatchObject({ ok: true });
  });

  it('reports signed but unparsable bodies as malformed', () => {
    const body = Buffer.from('not json');
    expect(verify(body, signed(body))).toEqual({ ok: false, reason: 'malformed' });
    const noType = Buffer.from(JSON.stringify({ data: {} }));
    expect(verify(noType, signed(noType))).toEqual({ ok: false, reason: 'malformed' });
  });

  it('parses duplicate deliveries to the same event identity', () => {
    const body = event('email.delivered');
    const headers = signed(body);
    const first = verify(body, headers);
    const second = verify(body, headers);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ ok: true, events: [{ externalEventId: 'msg_2abc' }] });
  });

  it('accepts header arrays and mixed-case header names', () => {
    const body = event('email.sent');
    const headers = signed(body);
    expect(
      verify(body, {
        'Svix-Id': [headers['svix-id']],
        'SVIX-TIMESTAMP': headers['svix-timestamp'],
        'svix-signature': headers['svix-signature'],
      }),
    ).toMatchObject({ ok: true });
  });
});

describe('Resend webhook event mapping', () => {
  const typeOf = (body: Buffer) => {
    const result = verify(body, signed(body));
    if (!result.ok) throw new Error(result.reason);
    return result.events[0]?.type;
  };

  it.each([
    ['email.sent', 'accepted'],
    ['email.delivered', 'delivered'],
    ['email.delivery_delayed', 'delivery_delayed'],
    ['email.complained', 'complained'],
    ['email.failed', 'failed'],
    ['email.opened', 'opened'],
    ['email.clicked', 'clicked'],
    ['email.scheduled', 'other'],
    ['domain.updated', 'other'],
  ])('maps %s to %s', (type, expected) => {
    expect(typeOf(event(type))).toBe(expected);
  });

  it('distinguishes hard and soft bounces by bounce type', () => {
    expect(
      typeOf(event('email.bounced', { bounce: { type: 'Permanent', subType: 'General' } })),
    ).toBe('bounced_hard');
    expect(
      typeOf(event('email.bounced', { bounce: { type: 'Transient', subType: 'MailboxFull' } })),
    ).toBe('bounced_soft');
    expect(typeOf(event('email.bounced', { bounce: { type: 'Undetermined' } }))).toBe(
      'bounced_soft',
    );
    expect(typeOf(event('email.bounced'))).toBe('bounced_hard');
  });

  it('keeps only classification labels in the payload', () => {
    const body = event('email.bounced', {
      bounce: {
        type: 'Permanent',
        subType: 'General',
        message: 'person@example.test does not exist',
      },
      click: { link: 'https://example.test/?token=secret' },
    });
    const result = verify(body, signed(body));
    expect(result).toMatchObject({
      ok: true,
      events: [
        {
          payload: {
            providerEventType: 'email.bounced',
            bounceType: 'Permanent',
            bounceSubType: 'General',
          },
        },
      ],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('example.test');
    expect(serialized).not.toContain('Private subject');
  });

  it('falls back to the signed timestamp when created_at is missing', () => {
    const body = Buffer.from(JSON.stringify({ type: 'email.sent', data: { email_id: 're_1' } }));
    const result = verify(body, signed(body));
    expect(result).toMatchObject({
      ok: true,
      events: [{ occurredAt: new Date(Number(NOW_SECONDS) * 1000) }],
    });
  });

  it('leaves the message id empty for events without an email', () => {
    const body = Buffer.from(JSON.stringify({ type: 'domain.created', data: { id: 'd_1' } }));
    expect(verify(body, signed(body))).toMatchObject({
      ok: true,
      events: [{ externalMessageId: null }],
    });
  });
});
