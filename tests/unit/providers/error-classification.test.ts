import { describe, expect, it } from 'vitest';
import {
  classifyFetchFailure,
  classifyResendStatus,
  parseRetryAfterMs,
} from '../../../src/infrastructure/providers/email/resend-classification.js';
import { classifySmtpError } from '../../../src/infrastructure/providers/email/smtp-classification.js';

describe('SMTP error classification', () => {
  it('treats explicit replies at MAIL/RCPT/DATA as certain rejections', () => {
    expect(
      classifySmtpError({ code: 'EENVELOPE', responseCode: 450, command: 'MAIL FROM' }, 'envelope'),
    ).toMatchObject({
      outcome: 'rejected',
      error: { kind: 'retryable', code: 'sender_rejected', definitelyNotAccepted: true },
    });
    expect(
      classifySmtpError({ code: 'EMESSAGE', responseCode: 552, command: 'DATA' }, 'data'),
    ).toMatchObject({
      outcome: 'rejected',
      error: { kind: 'permanent', code: 'message_rejected', definitelyNotAccepted: true },
    });
  });

  it('treats authentication replies as configuration errors', () => {
    expect(
      classifySmtpError({ code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN' }, 'auth'),
    ).toMatchObject({
      error: { kind: 'configuration', code: 'authentication_failed' },
    });
    expect(
      classifySmtpError({ code: 'EENVELOPE', responseCode: 530, command: 'MAIL FROM' }, 'envelope'),
    ).toMatchObject({
      error: { kind: 'configuration', code: 'authentication_failed' },
    });
  });

  it('is certain about connection failures before any message data', () => {
    for (const code of ['ECONNECTION', 'ESOCKET', 'EDNS']) {
      expect(classifySmtpError({ code }, 'connect')).toMatchObject({
        error: { kind: 'retryable', code: 'connection_failed', definitelyNotAccepted: true },
      });
    }
    expect(classifySmtpError({ code: 'ETLS' }, 'connect')).toMatchObject({
      error: { kind: 'retryable', code: 'tls_failed', definitelyNotAccepted: true },
    });
    expect(classifySmtpError({ code: 'ETIMEDOUT' }, 'envelope')).toMatchObject({
      error: { kind: 'retryable', code: 'timeout', definitelyNotAccepted: true },
    });
  });

  it('returns unknown for losses, timeouts and garbage after message data started', () => {
    expect(classifySmtpError({ code: 'ETIMEDOUT', command: 'CONN' }, 'data')).toEqual({
      outcome: 'unknown',
      reason: 'timeout_after_submission',
    });
    expect(
      classifySmtpError({ code: 'ECONNECTION', responseCode: 421, command: 'CONN' }, 'data'),
    ).toEqual({
      outcome: 'unknown',
      reason: 'connection_lost_after_submission',
    });
    expect(classifySmtpError({ code: 'EPROTOCOL', command: 'CONN' }, 'data')).toEqual({
      outcome: 'unknown',
      reason: 'unparsable_response',
    });
  });
});

describe('Resend HTTP classification', () => {
  const headers = (values: Record<string, string> = {}) => new Headers(values);

  it('parses Retry-After as seconds or HTTP date', () => {
    const now = new Date('2026-10-17T12:00:00Z');
    expect(parseRetryAfterMs(headers({ 'retry-after': '2' }), now)).toBe(2_000);
    expect(
      parseRetryAfterMs(headers({ 'retry-after': 'Sat, 17 Oct 2026 12:00:30 GMT' }), now),
    ).toBe(30_000);
    expect(parseRetryAfterMs(headers({ 'ratelimit-reset': '4' }), now)).toBe(4_000);
    expect(parseRetryAfterMs(headers({ 'retry-after': 'soon' }), now)).toBeUndefined();
    expect(parseRetryAfterMs(headers(), now)).toBeUndefined();
  });

  it('omits retryAfterMs on 429 without hints', () => {
    const result = classifyResendStatus(429, headers(), 'rate_limit_exceeded');
    expect(result).toMatchObject({ outcome: 'rejected', error: { kind: 'retryable' } });
    expect(result.outcome === 'rejected' && 'retryAfterMs' in result.error).toBe(false);
  });

  it('never treats server errors or unexpected statuses as certain rejections', () => {
    for (const status of [500, 502, 503, 504, 302, 408]) {
      expect(classifyResendStatus(status, headers(), undefined).outcome).toBe('unknown');
    }
  });

  it('distinguishes pre-request network failures from ambiguous ones', () => {
    const fetchError = (cause: unknown) => new TypeError('fetch failed', { cause });
    expect(classifyFetchFailure(fetchError({ code: 'ENOTFOUND' }), undefined)).toMatchObject({
      error: { kind: 'retryable', code: 'connection_failed', definitelyNotAccepted: true },
    });
    expect(
      classifyFetchFailure(
        fetchError({
          code: 'ECONNREFUSED',
          errors: [{ code: 'ECONNREFUSED' }, { code: 'ENETUNREACH' }],
        }),
        undefined,
      ),
    ).toMatchObject({ outcome: 'rejected' });
    expect(
      classifyFetchFailure(
        fetchError({ errors: [{ code: 'ECONNREFUSED' }, { code: 'ECONNRESET' }] }),
        undefined,
      ),
    ).toMatchObject({ outcome: 'unknown' });
    expect(classifyFetchFailure(fetchError({ code: 'CERT_HAS_EXPIRED' }), undefined)).toMatchObject(
      {
        error: { code: 'tls_failed', definitelyNotAccepted: true },
      },
    );
    expect(classifyFetchFailure(fetchError({ code: 'ECONNRESET' }), undefined).outcome).toBe(
      'unknown',
    );
    expect(classifyFetchFailure(fetchError({ code: 'UND_ERR_SOCKET' }), undefined).outcome).toBe(
      'unknown',
    );
    expect(classifyFetchFailure(new Error('weird'), undefined).outcome).toBe('unknown');
    expect(classifyFetchFailure(new Error('aborted'), 'timeout')).toEqual({
      outcome: 'unknown',
      reason: 'timeout_after_submission',
    });
  });
});
