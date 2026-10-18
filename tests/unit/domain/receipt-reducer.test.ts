import { describe, expect, it } from 'vitest';
import type { NormalizedEventType } from '../../../src/contracts/provider-port.js';
import {
  applyReceiptEvent,
  foldReceipt,
  receiptEffect,
  receiptTransition,
} from '../../../src/domain/receipt-reducer.js';

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  );
}

describe('receipt reducer', () => {
  it('a late accepted event does not downgrade delivered or undeliverable', () => {
    expect(applyReceiptEvent('delivered', 'accepted')).toBe('delivered');
    expect(applyReceiptEvent('undeliverable', 'accepted')).toBe('undeliverable');
    expect(foldReceipt('pending', ['delivered', 'accepted'])).toBe('delivered');
  });

  it('is order independent for any arrival order', () => {
    const events: NormalizedEventType[] = ['accepted', 'delivered', 'opened', 'delivery_delayed'];
    for (const order of permutations(events)) {
      expect(foldReceipt('pending', order)).toBe('delivered');
    }
    const withBounce: NormalizedEventType[] = ['accepted', 'delivered', 'bounced_hard'];
    for (const order of permutations(withBounce)) {
      expect(foldReceipt('pending', order)).toBe('undeliverable');
    }
  });

  it('is idempotent on duplicates', () => {
    expect(foldReceipt('pending', ['delivered', 'delivered', 'delivered'])).toBe('delivered');
    expect(foldReceipt('pending', ['accepted', 'accepted'])).toBe('pending');
  });

  it('soft bounces, delays and interactions do not change the receipt', () => {
    for (const type of [
      'bounced_soft',
      'delivery_delayed',
      'opened',
      'clicked',
      'complained',
      'other',
    ] as const) {
      expect(applyReceiptEvent('pending', type)).toBe('pending');
    }
  });

  it('hard bounces and complaints feed suppressions; nothing triggers a send', () => {
    expect(receiptEffect('bounced_hard').suppression).toBe('hard_bounce');
    expect(receiptEffect('complained').suppression).toBe('complaint');
    expect(receiptEffect('bounced_soft').suppression).toBeNull();
    expect(receiptEffect('failed').suppression).toBeNull();
  });

  it('only provider-known events prove acceptance of an unknown submission', () => {
    expect(receiptEffect('delivered').provesAcceptance).toBe(true);
    expect(receiptEffect('other').provesAcceptance).toBe(false);
  });

  it('builds compare-and-set transitions from strictly lower ranks', () => {
    expect(receiptTransition('accepted')).toEqual({ from: ['unavailable'], to: 'pending' });
    expect(receiptTransition('delivered')).toEqual({
      from: ['unavailable', 'pending'],
      to: 'delivered',
    });
    expect(receiptTransition('bounced_hard')).toEqual({
      from: ['unavailable', 'pending', 'delivered'],
      to: 'undeliverable',
    });
    expect(receiptTransition('opened')).toBeNull();
  });
});
