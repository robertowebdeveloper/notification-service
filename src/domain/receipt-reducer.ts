import type { NormalizedEventType } from '../contracts/provider-port.js';
import type { ReceiptStatus } from '../contracts/statuses.js';
import { RECEIPT_RANK, receiptStatusesBelow } from './delivery-state.js';

export type SuppressionReasonFromEvent = 'hard_bounce' | 'complaint';

/**
 * Effect of one provider event on a delivery. The reducer is deterministic and monotonic:
 * the receipt only moves to a higher rank (unavailable < pending < delivered < undeliverable),
 * so duplicates are no-ops and the final state does not depend on arrival order.
 * No event ever schedules a new send: bounces and negative receipts only update the receipt
 * and, for hard bounces and complaints, feed the suppression list.
 */
export interface ReceiptEffect {
  /** Target receipt, or null when the event does not affect the receipt. */
  receipt: ReceiptStatus | null;
  suppression: SuppressionReasonFromEvent | null;
  /** The provider knows the message: an `unknown` submission was in fact accepted. */
  provesAcceptance: boolean;
}

const EFFECTS: Readonly<Record<NormalizedEventType, ReceiptEffect>> = {
  accepted: { receipt: 'pending', suppression: null, provesAcceptance: true },
  delivered: { receipt: 'delivered', suppression: null, provesAcceptance: true },
  delivery_delayed: { receipt: null, suppression: null, provesAcceptance: true },
  bounced_hard: { receipt: 'undeliverable', suppression: 'hard_bounce', provesAcceptance: true },
  bounced_soft: { receipt: null, suppression: null, provesAcceptance: true },
  // Complaints and interactions are separate events: they do not rewrite the receipt.
  complained: { receipt: null, suppression: 'complaint', provesAcceptance: true },
  failed: { receipt: 'undeliverable', suppression: null, provesAcceptance: true },
  opened: { receipt: null, suppression: null, provesAcceptance: true },
  clicked: { receipt: null, suppression: null, provesAcceptance: true },
  other: { receipt: null, suppression: null, provesAcceptance: false },
};

export function receiptEffect(type: NormalizedEventType): ReceiptEffect {
  return EFFECTS[type];
}

/** Compare-and-set arguments: apply `to` only when the current receipt is one of `from`. */
export function receiptTransition(
  type: NormalizedEventType,
): { from: ReceiptStatus[]; to: ReceiptStatus } | null {
  const target = EFFECTS[type].receipt;
  return target === null ? null : { from: receiptStatusesBelow(target), to: target };
}

/** Pure reduction of one event on the current receipt. */
export function applyReceiptEvent(
  current: ReceiptStatus,
  type: NormalizedEventType,
): ReceiptStatus {
  const target = EFFECTS[type].receipt;
  if (target === null) return current;
  return RECEIPT_RANK[target] > RECEIPT_RANK[current] ? target : current;
}

export function foldReceipt(
  initial: ReceiptStatus,
  types: readonly NormalizedEventType[],
): ReceiptStatus {
  return types.reduce(applyReceiptEvent, initial);
}
