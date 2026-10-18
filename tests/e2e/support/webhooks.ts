import { randomBytes, randomUUID } from 'node:crypto';
import { signSvixPayload } from '../../../src/infrastructure/providers/email/resend-webhook.js';

/** Fresh Svix-style signing secret (`whsec_` + base64). */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('base64')}`;
}

export interface ResendEventInput {
  /** Resend event type, e.g. `email.delivered`, `email.sent`, `email.bounced`. */
  type: string;
  emailId: string;
  /** Provider event time (defaults to now). */
  createdAt?: Date;
  /** svix-id; reuse it to simulate a duplicate delivery of the same event. */
  eventId?: string;
  /** Signature timestamp (defaults to now; must be within the 5 minute tolerance). */
  signedAt?: Date;
  extraData?: Record<string, unknown>;
}

export interface SignedWebhook {
  eventId: string;
  rawBody: string;
  headers: Record<string, string>;
}

/** Builds a Resend webhook request signed exactly as Svix does (see resend-webhook.ts). */
export function signedResendWebhook(secret: string, input: ResendEventInput): SignedWebhook {
  const eventId = input.eventId ?? `msg_e2e_${randomUUID()}`;
  const createdAt = (input.createdAt ?? new Date()).toISOString();
  const rawBody = JSON.stringify({
    type: input.type,
    created_at: createdAt,
    data: {
      email_id: input.emailId,
      created_at: createdAt,
      to: ['redacted@example.test'],
      ...input.extraData,
    },
  });
  const timestamp = String(Math.floor((input.signedAt ?? new Date()).getTime() / 1000));
  const signature = signSvixPayload(secret, eventId, timestamp, Buffer.from(rawBody, 'utf8'));
  return {
    eventId,
    rawBody,
    headers: {
      'svix-id': eventId,
      'svix-timestamp': timestamp,
      'svix-signature': `v1,${signature}`,
    },
  };
}
