import Fastify from 'fastify';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import {
  createLogger,
  loggerOptions,
  scrubText,
  serializeError,
} from '../../../src/infrastructure/observability/logger.js';

const API_KEY = `ns_0123456789ab_${'A'.repeat(43)}`;

function capture() {
  const lines: string[] = [];
  const logger = createLogger({ LOG_LEVEL: 'debug' }, 'test', {
    write: (line: string) => {
      lines.push(line);
    },
  });
  return {
    logger,
    output: () => lines.join(''),
    last: () => JSON.parse(lines.at(-1) ?? '{}') as unknown,
  };
}

describe('logger redaction', () => {
  it('redacts recipients and content of a channel payload at any logged depth up to 2', () => {
    const { logger, output } = capture();
    const payload = {
      channel: 'email',
      recipient: { email: 'alice@example.com' },
      content: {
        from: 'noreply@example.com',
        subject: 'Reset',
        text: 'code 1234',
        html: '<b>x</b>',
      },
    };
    logger.info({ payload }, 'top');
    logger.info({ job: { payload } }, 'nested');
    logger.info({ recipient: { email: 'bob@example.com' }, subject: 'Hi', text: 'body' }, 'flat');

    const text = output();
    for (const secret of [
      'alice@example.com',
      'bob@example.com',
      'Reset',
      'code 1234',
      '<b>x</b>',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('[redacted]');
  });

  it('redacts every channel recipient kind', () => {
    const { logger, output } = capture();
    logger.info(
      {
        sms: { phoneNumber: '+393331234567' },
        push: { platform: 'fcm', deviceToken: 'device-token-abc' },
        messaging: { platform: 'telegram', chatId: 'chat-987' },
        smtp: { envelope: { from: 'a@b.it', to: ['c@d.it'] }, to: 'c@d.it', cc: 'e@f.it' },
      },
      'recipients',
    );
    const text = output();
    for (const secret of ['+393331234567', 'device-token-abc', 'chat-987', 'c@d.it', 'e@f.it']) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('"platform":"fcm"');
  });

  it('redacts credentials, provider secrets and authorization headers', () => {
    const { logger, output } = capture();
    logger.info(
      {
        req: { headers: { authorization: `Bearer ${API_KEY}`, 'svix-signature': 'v1,sig' } },
        headers: { 'x-api-key': 'k-1', cookie: 'sid=1' },
        instance: { config: { host: 'smtp', auth: { user: 'u', pass: 'smtp-pass' } } },
        provider: { apiKey: 're_live_key', secrets: { apiKey: 'x' }, webhookSecret: 'whsec_1' },
        token: 'tok',
      },
      'credentials',
    );
    const text = output();
    for (const secret of [
      API_KEY,
      'v1,sig',
      'k-1',
      'sid=1',
      'smtp-pass',
      're_live_key',
      'whsec_1',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain('"token":"tok"');
    expect(text).toContain('"host":"smtp"');
  });

  it('keeps identifiers, durations, outcomes and codes', () => {
    const { logger, last } = capture();
    logger.info(
      {
        deliveryId: 'd-1',
        tenantId: 't-1',
        providerType: 'smtp',
        durationMs: 12,
        outcome: 'rejected',
        errorCode: 'mailbox_unavailable',
      },
      'provider attempt resolved',
    );
    expect(last()).toMatchObject({
      role: 'test',
      deliveryId: 'd-1',
      durationMs: 12,
      outcome: 'rejected',
      errorCode: 'mailbox_unavailable',
    });
  });

  it('scrubs recipients and keys from provider error messages logged as Error or string', () => {
    const { logger, output } = capture();
    const smtpError = Object.assign(
      new Error("Can't send mail - all recipients were rejected: 550 5.1.1 <carol@example.org>"),
      {
        code: 'EENVELOPE',
        responseCode: 550,
        response: '550 5.1.1 <carol@example.org>: Recipient address rejected',
        rejected: ['carol@example.org'],
        rejectedErrors: [{ recipient: 'carol@example.org' }],
      },
    );
    logger.error({ err: smtpError, deliveryId: 'd-1' }, 'provider adapter threw');
    logger.error({ err: 'invalid number +39 333 123 4567 for sms' }, 'string error');
    logger.warn({ err: { message: `auth failed for Bearer ${API_KEY}` } }, 'object error');
    logger.error(smtpError, 'error as first argument');

    const text = output();
    expect(text).not.toContain('carol@example.org');
    expect(text).not.toContain('333 123 4567');
    expect(text).not.toContain(API_KEY);
    expect(text).toContain('EENVELOPE');
    expect(text).toContain('550 5.1.1 <[email]>');
    expect(text).toContain('"deliveryId":"d-1"');
  });

  it('applies the same options to the Fastify request logger', async () => {
    const lines: string[] = [];
    const app = Fastify({
      loggerInstance: pino(loggerOptions({ LOG_LEVEL: 'info' }, 'api'), {
        write: (line: string) => {
          lines.push(line);
        },
      }),
    });
    app.get('/x', (request) => {
      request.log.error({ err: new Error('to dave@example.net failed') }, 'request failed');
      return { ok: true };
    });
    await app.inject({ method: 'GET', url: '/x', headers: { authorization: `Bearer ${API_KEY}` } });
    await app.close();
    const text = lines.join('');
    expect(text).toContain('request failed');
    expect(text).not.toContain('dave@example.net');
    expect(text).not.toContain(API_KEY);
  });
});

describe('scrubText', () => {
  it('replaces emails, phone numbers, bearer tokens and API keys', () => {
    expect(scrubText('to <a.b+c@sub.example.co.uk> ok')).toBe('to <[email]> ok');
    expect(scrubText('sms +393331234567 rejected')).toBe('sms [phone] rejected');
    expect(scrubText('Authorization: Bearer abc.def-ghi')).toBe('Authorization: Bearer [redacted]');
    expect(scrubText(`key ${API_KEY}`)).toBe('key [api-key]');
    expect(scrubText('key re_123456789abcdefghijk')).toBe('key [api-key]');
  });

  it('leaves timestamps, ids and codes untouched', () => {
    const text = '2026-10-18T10:00:00.000+02:00 delivery 7f1c-11 code 421 at file.ts:12:3';
    expect(scrubText(text)).toBe(text);
  });
});

describe('serializeError', () => {
  it('handles nested causes and cycles', () => {
    const cause = new Error('mailbox eve@example.com full');
    const error = new Error('send failed', { cause });
    const cyclic: Record<string, unknown> = { message: 'x' };
    cyclic.self = cyclic;
    const serialized = JSON.stringify([serializeError(error), serializeError(cyclic)]);
    expect(serialized).not.toContain('eve@example.com');
    expect(serialized).toContain('[truncated]');
  });
});
