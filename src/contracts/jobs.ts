import type { Channel } from './channels.js';

/** Job payload: references only, never PII. */
export interface DeliveryJobData {
  deliveryId: number;
  generation: number;
  outboxEventId: number;
}

export const QUEUE_NAMES = {
  email: 'notifications-email-v1',
} as const satisfies Partial<Record<Channel, string>>;

export function dispatchJobId(outboxEventId: number, dispatchSequence: number): string {
  return `dispatch-${outboxEventId}-${dispatchSequence}`;
}
