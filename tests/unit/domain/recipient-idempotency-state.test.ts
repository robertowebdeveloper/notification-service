import { describe, expect, it } from 'vitest';
import type { ProviderCapabilities } from '../../../src/contracts/provider-port.js';
import {
  canTransition,
  isFinalSubmission,
  isRunnable,
  receiptStatusesBelow,
} from '../../../src/domain/delivery-state.js';
import {
  deriveProviderIdempotencyKey,
  isWithinReplayWindow,
  safeReplayDeadline,
} from '../../../src/domain/idempotency.js';
import { normalizeEmailAddress, recipientKey } from '../../../src/domain/recipient.js';

describe('recipient normalization for suppressions', () => {
  it('lower-cases and IDNA-encodes only the email domain', () => {
    expect(normalizeEmailAddress('  John.Doe+Tag@Example.COM ')).toBe('John.Doe+Tag@example.com');
    expect(normalizeEmailAddress('user@Bücher.Example')).toBe('user@xn--bcher-kva.example');
  });

  it('is non-destructive for the local part', () => {
    expect(normalizeEmailAddress('a.b@example.com')).not.toBe(
      normalizeEmailAddress('ab@example.com'),
    );
    expect(normalizeEmailAddress('A@example.com')).not.toBe(normalizeEmailAddress('a@example.com'));
  });

  it('builds channel-specific keys', () => {
    expect(
      recipientKey({
        channel: 'sms',
        recipient: { phoneNumber: '+39 333 123-4567' },
        content: { text: 'x' },
      }),
    ).toBe('+393331234567');
    expect(
      recipientKey({
        channel: 'push',
        recipient: { platform: 'fcm', deviceToken: ' tok ' },
        content: { title: 't', body: 'b' },
      }),
    ).toBe('fcm:tok');
    expect(
      recipientKey({
        channel: 'messaging',
        recipient: { platform: 'telegram', chatId: '42' },
        content: { type: 'text', text: 'hi' },
      }),
    ).toBe('telegram:42');
  });
});

describe('provider idempotency key', () => {
  const operation = {
    tenantId: 1,
    deliveryId: 41,
    deliveryCreatedAt: new Date('2026-10-18T10:00:00.000Z'),
    providerInstanceId: 7,
    operationAttemptNumber: 1,
  };

  it('is deterministic for the same persisted operation and printable', () => {
    const key = deriveProviderIdempotencyKey(operation);
    expect(deriveProviderIdempotencyKey({ ...operation })).toBe(key);
    expect(key).toMatch(/^nsd1-[0-9a-f]{64}$/);
    expect(key).not.toContain('41:');
  });

  it('differs for a new operation (other attempt or provider)', () => {
    const key = deriveProviderIdempotencyKey(operation);
    expect(deriveProviderIdempotencyKey({ ...operation, operationAttemptNumber: 2 })).not.toBe(key);
    expect(deriveProviderIdempotencyKey({ ...operation, providerInstanceId: 8 })).not.toBe(key);
  });

  it('differs for a delivery with the same id created at another time (database reset)', () => {
    const key = deriveProviderIdempotencyKey(operation);
    const recreated = { ...operation, deliveryCreatedAt: new Date('2026-10-19T10:00:00.000Z') };
    expect(deriveProviderIdempotencyKey(recreated)).not.toBe(key);
  });
});

describe('safe replay window', () => {
  const firstUse = new Date('2026-10-18T00:00:00.000Z');
  const idempotent: ProviderCapabilities = {
    channels: ['email'],
    platforms: [],
    formats: ['text'],
    idempotency: { supported: true, windowSeconds: 24 * 3600 },
    receipts: true,
    statusQuery: true,
  };

  it('ends one safety margin before the provider window', () => {
    expect(safeReplayDeadline(idempotent, firstUse, 3600_000)).toEqual(
      new Date('2026-10-18T23:00:00.000Z'),
    );
    expect(
      isWithinReplayWindow(idempotent, firstUse, new Date('2026-10-18T22:59:59.000Z'), 3600_000),
    ).toBe(true);
    expect(
      isWithinReplayWindow(idempotent, firstUse, new Date('2026-10-18T23:00:00.000Z'), 3600_000),
    ).toBe(false);
  });

  it('never allows replays without provider idempotency', () => {
    const smtp = { ...idempotent, idempotency: { supported: false as const } };
    expect(safeReplayDeadline(smtp, firstUse)).toBeNull();
    expect(isWithinReplayWindow(smtp, firstUse, firstUse)).toBe(false);
  });
});

describe('delivery state machine', () => {
  it('allows only the documented transitions', () => {
    expect(canTransition('pending', 'sending')).toBe(true);
    expect(canTransition('sending', 'unknown')).toBe(true);
    expect(canTransition('unknown', 'sending')).toBe(false);
    expect(canTransition('unknown', 'accepted')).toBe(true);
    expect(canTransition('accepted', 'retry_wait')).toBe(false);
    expect(canTransition('failed', 'retry_wait')).toBe(true);
    expect(canTransition('suppressed', 'sending')).toBe(false);
  });

  it('classifies runnable and final statuses', () => {
    expect(isRunnable('pending')).toBe(true);
    expect(isRunnable('retry_wait')).toBe(true);
    expect(isRunnable('unknown')).toBe(false);
    expect(isFinalSubmission('accepted')).toBe(true);
    expect(isFinalSubmission('failed')).toBe(false);
  });

  it('lists the receipts a target may replace', () => {
    expect(receiptStatusesBelow('unavailable')).toEqual([]);
    expect(receiptStatusesBelow('delivered')).toEqual(['unavailable', 'pending']);
  });
});
