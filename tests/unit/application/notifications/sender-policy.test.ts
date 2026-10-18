import { describe, expect, it } from 'vitest';
import { Value } from 'typebox/value';
import { isSenderAllowed } from '../../../../src/application/notifications/sender-policy.js';
import {
  formatMailbox,
  MAILBOX_PATTERN_SOURCE,
  parseMailbox,
} from '../../../../src/contracts/email-address.js';
import { EmailNotificationBody } from '../../../../src/contracts/http-schemas.js';

const RULES = ['no-reply@example.test', '@notifications.example.test'];

/** Payloads that smuggle a second (unauthorized) address next to an allowed one. */
const BYPASS_PAYLOADS = [
  '<evil@attacker.test> <no-reply@example.test>',
  'evil@attacker.test, <no-reply@example.test>',
  'evil@attacker.test,no-reply@example.test',
  'evil@attacker.test; no-reply@example.test',
  'Evil <evil@attacker.test>, Ok <no-reply@example.test>',
  'evil@attacker.test <no-reply@example.test>',
  '"evil@attacker.test" <no-reply@example.test>',
  'Name <no-reply@example.test> evil@attacker.test',
  'Name <no-reply@example.test>, evil@attacker.test',
  'group: evil@attacker.test; <no-reply@example.test>',
  'Name\r\nBcc: victim@example.org <no-reply@example.test>',
  'no-reply@example.test\r\nBcc: victim@example.org',
  'Name\n<no-reply@example.test>',
  'Na<me <no-reply@example.test>',
  'Na>me <no-reply@example.test>',
  '"Na\\"me" <no-reply@example.test>',
  '<no-reply@example.test> (comment evil@attacker.test)',
  'no-reply@example.test (evil@attacker.test)',
  'no-reply@[127.0.0.1]',
  '"no reply"@example.test',
  '<<no-reply@example.test>>',
  '',
];

describe('strict single-mailbox parsing', () => {
  it.each([
    ['no-reply@example.test', { address: 'no-reply@example.test' }],
    ['  no-reply@example.test  ', { address: 'no-reply@example.test' }],
    ['<no-reply@example.test>', { address: 'no-reply@example.test' }],
    ['Orders <Orders@Example.TEST>', { name: 'Orders', address: 'Orders@Example.TEST' }],
    ['"Shop (EU)" <shop@example.test>', { name: 'Shop (EU)', address: 'shop@example.test' }],
    ['Ordini Città <a@example.test>', { name: 'Ordini Città', address: 'a@example.test' }],
    ['"" <a@example.test>', { address: 'a@example.test' }],
  ])('accepts %j', (input, expected) => {
    expect(parseMailbox(input)).toEqual(expected);
  });

  it.each(BYPASS_PAYLOADS)('rejects %j', (input) => {
    expect(parseMailbox(input)).toBeNull();
  });

  it('rejects over-long local parts, addresses and display names', () => {
    expect(parseMailbox(`${'a'.repeat(65)}@example.test`)).toBeNull();
    expect(
      parseMailbox(
        `a@${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.${'e'.repeat(70)}.test`,
      ),
    ).toBeNull();
    expect(parseMailbox(`${'N'.repeat(257)} <a@example.test>`)).toBeNull();
  });

  it('formats a parsed mailbox, quoting names with specials', () => {
    expect(formatMailbox({ address: 'a@example.test' })).toBe('a@example.test');
    expect(formatMailbox({ name: 'Orders', address: 'a@example.test' })).toBe(
      'Orders <a@example.test>',
    );
    expect(formatMailbox({ name: 'Shop (EU) Inc.', address: 'a@example.test' })).toBe(
      '"Shop (EU) Inc." <a@example.test>',
    );
  });

  it('uses one grammar for the HTTP schema pattern and the parser', () => {
    const pattern = new RegExp(MAILBOX_PATTERN_SOURCE, 'u');
    for (const input of BYPASS_PAYLOADS) expect(pattern.test(input)).toBe(false);
    for (const input of ['a@example.test', 'A <a@example.test>', '"A. B" <a@example.test>']) {
      expect(pattern.test(input)).toBe(true);
    }
  });
});

describe('sender allow-list', () => {
  it.each(BYPASS_PAYLOADS)('denies the bypass payload %j', (from) => {
    expect(isSenderAllowed(from, RULES)).toBe(false);
  });

  it('allows exactly the configured mailbox and domain', () => {
    expect(isSenderAllowed('No-Reply@Example.test', RULES)).toBe(true);
    expect(isSenderAllowed('Team <a@notifications.example.test>', RULES)).toBe(true);
    expect(isSenderAllowed('"Team" <no-reply@example.test>', RULES)).toBe(true);
    expect(isSenderAllowed('a@sub.notifications.example.test', RULES)).toBe(false);
  });

  it('rejects the bypass payloads at the HTTP schema', () => {
    const body = (from: string) => ({
      channel: 'email',
      routingKey: 'transactional',
      recipient: { email: 'customer@example.org' },
      content: { from, subject: 's', text: 't' },
    });
    expect(Value.Check(EmailNotificationBody, body('Orders <orders@example.test>'))).toBe(true);
    for (const from of BYPASS_PAYLOADS) {
      expect(Value.Check(EmailNotificationBody, body(from))).toBe(false);
    }
  });
});
