import { describe, expect, it } from 'vitest';
import {
  requestHash,
  stableStringify,
} from '../../../../src/application/notifications/canonical.js';
import { ApplicationError } from '../../../../src/application/notifications/errors.js';
import {
  BacklogGuard,
  IngressLimiter,
} from '../../../../src/application/notifications/ingress-guards.js';
import {
  isSenderAllowed,
  senderAddress,
} from '../../../../src/application/notifications/sender-policy.js';

const silent = { warn: () => undefined };

describe('canonical request hash', () => {
  it('is independent of key order and sensitive to values', () => {
    expect(stableStringify({ b: 1, a: { d: [2, 1], c: null } })).toBe(
      '{"a":{"c":null,"d":[2,1]},"b":1}',
    );
    const base = {
      routingKey: 'r',
      channel: 'email',
      recipient: { email: 'x@example.test' },
      content: { subject: 's', from: 'f@example.test', text: 't' },
      metadata: {},
    };
    const reordered = { ...base, content: { text: 't', from: 'f@example.test', subject: 's' } };
    expect(requestHash(reordered)).toBe(requestHash(base));
    expect(requestHash({ ...base, metadata: { a: 1 } })).not.toBe(requestHash(base));
    expect(requestHash(base)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('sender policy', () => {
  it('extracts the mailbox from display-name forms', () => {
    expect(senderAddress('Orders <Orders@Example.TEST>')).toBe('orders@example.test');
    expect(senderAddress('plain@example.test')).toBe('plain@example.test');
    expect(senderAddress('no address')).toBeNull();
  });

  it('matches exact mailboxes and whole domains only', () => {
    const rules = ['no-reply@example.test', '@mail.example.test'];
    expect(isSenderAllowed('No-Reply@example.test', rules)).toBe(true);
    expect(isSenderAllowed('Team <a@mail.example.test>', rules)).toBe(true);
    expect(isSenderAllowed('other@example.test', rules)).toBe(false);
    expect(isSenderAllowed('a@sub.mail.example.test', rules)).toBe(false);
    expect(isSenderAllowed('a@evilmail.example.test', rules)).toBe(false);
    expect(isSenderAllowed('a@example.test', [])).toBe(false);
  });
});

describe('ingress guards', () => {
  it('rate limits per subject and fails open when the limiter throws', async () => {
    const keys: string[] = [];
    let allowed = true;
    let fail = false;
    const limiter = new IngressLimiter(
      {
        consume: (key) => {
          keys.push(key);
          return fail
            ? Promise.reject(new Error('down'))
            : Promise.resolve({ allowed, retryAfterMs: 2500 });
        },
      },
      { limit: 1, windowMs: 1000 },
      silent,
      'ingress:',
    );
    await limiter.check('t1');
    allowed = false;
    const error = await limiter.check('t1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApplicationError);
    expect((error as ApplicationError).code).toBe('rate_limited');
    expect((error as ApplicationError).retryAfterSeconds).toBe(3);
    fail = true;
    await expect(limiter.check('t1')).resolves.toBeUndefined();
    expect(keys).toEqual(['ingress:t1', 'ingress:t1', 'ingress:t1']);
  });

  it('caches the backlog count and rejects above the threshold', async () => {
    let count = 5;
    let calls = 0;
    let now = 0;
    const guard = new BacklogGuard(
      () => {
        calls += 1;
        return Promise.resolve(count);
      },
      5,
      1000,
      () => now,
    );
    await expect(guard.assertAccepting()).resolves.toBeUndefined();
    count = 6;
    await expect(guard.assertAccepting()).resolves.toBeUndefined();
    expect(calls).toBe(1);
    now = 1000;
    await expect(guard.assertAccepting()).rejects.toMatchObject({ code: 'dependency_unavailable' });
    expect(calls).toBe(2);
  });
});
