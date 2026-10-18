export const SUBMISSION_STATUSES = [
  'pending',
  'sending',
  'retry_wait',
  'accepted',
  'failed',
  'unknown',
  'suppressed',
  'expired',
] as const;
export type SubmissionStatus = (typeof SUBMISSION_STATUSES)[number];

export const RECEIPT_STATUSES = ['unavailable', 'pending', 'delivered', 'undeliverable'] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

export const ATTEMPT_OUTCOMES = ['started', 'accepted', 'rejected', 'unknown'] as const;
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number];

export const OUTBOX_EVENT_TYPES = ['dispatch_delivery'] as const;
export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];

export const OUTBOX_STATUSES = ['pending', 'publishing', 'published'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export const API_SCOPES = [
  'notifications:write',
  'notifications:read',
  'notifications:retry',
] as const;
export type ApiScope = (typeof API_SCOPES)[number];
