import type { Channel } from './channels.js';

/** Job payload: references only, never PII. */
export interface DeliveryJobData {
  deliveryId: string;
  generation: number;
  outboxEventId: string;
}

export const QUEUE_NAMES = {
  email: 'notifications-email-v1',
} as const satisfies Partial<Record<Channel, string>>;

export function dispatchJobId(outboxEventId: string, dispatchSequence: number): string {
  return `dispatch-${outboxEventId}-${dispatchSequence}`;
}
