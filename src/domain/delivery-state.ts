import type { ReceiptStatus, SubmissionStatus } from '../contracts/statuses.js';

/**
 * Submission state machine. PostgreSQL enforces each transition with fenced conditional
 * updates; this table is the reference used by tests and by the delivery use cases.
 *
 * - `pending`/`retry_wait` are runnable: a worker may claim them.
 * - `sending` means an attempt is persisted and a provider call may be in flight: it can only
 *   end through the attempt resolution or, when the lease expires, through `unknown`.
 * - `unknown` never goes back to sending directly: it is resolved by reconciliation (status
 *   query or webhook evidence -> `accepted`) or by a safe replay (`retry_wait`) through the same
 *   provider inside its idempotency window.
 * - `accepted`, `suppressed`, `expired` are final. `failed` is final for the pipeline; only an
 *   explicit, audited manual retry moves it back to `retry_wait`.
 */
const SUBMISSION_TRANSITIONS: Readonly<Record<SubmissionStatus, readonly SubmissionStatus[]>> = {
  pending: ['sending', 'expired', 'suppressed', 'failed'],
  retry_wait: ['sending', 'expired', 'suppressed', 'failed', 'unknown'],
  sending: ['accepted', 'retry_wait', 'failed', 'unknown'],
  unknown: ['accepted', 'retry_wait'],
  failed: ['retry_wait'],
  accepted: [],
  suppressed: [],
  expired: [],
};

export const RUNNABLE_STATUSES: readonly SubmissionStatus[] = ['pending', 'retry_wait'];

export function canTransition(from: SubmissionStatus, to: SubmissionStatus): boolean {
  return SUBMISSION_TRANSITIONS[from].includes(to);
}

export function isRunnable(status: SubmissionStatus): boolean {
  return RUNNABLE_STATUSES.includes(status);
}

/** Statuses after which the pipeline never sends again on its own. */
export function isFinalSubmission(status: SubmissionStatus): boolean {
  return status === 'accepted' || status === 'suppressed' || status === 'expired';
}

/**
 * Receipt precedence: higher rank wins and is never downgraded. `undeliverable` outranks
 * `delivered` because an asynchronous bounce after a delivery report is the later truth.
 */
export const RECEIPT_RANK: Readonly<Record<ReceiptStatus, number>> = {
  unavailable: 0,
  pending: 1,
  delivered: 2,
  undeliverable: 3,
};

/** Receipt statuses that may be replaced by `target` (strictly lower rank). */
export function receiptStatusesBelow(target: ReceiptStatus): ReceiptStatus[] {
  return (Object.keys(RECEIPT_RANK) as ReceiptStatus[]).filter(
    (status) => RECEIPT_RANK[status] < RECEIPT_RANK[target],
  );
}
