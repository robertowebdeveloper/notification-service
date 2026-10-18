import { randomUUID } from 'node:crypto';

/** Only reserved `example.test` addresses: the suite never targets real recipients. */
export function uniqueRecipient(tag = 'e2e'): string {
  return `${tag}-${randomUUID()}@example.test`;
}

export function uniqueIdempotencyKey(tag = 'e2e'): string {
  return `${tag}-${randomUUID()}`;
}

export interface EmailRequestOptions {
  routingKey?: string;
  subject?: string;
  text?: string;
  html?: string;
  metadata?: Record<string, string | number | boolean>;
}

export function emailRequest(recipient: string, options: EmailRequestOptions = {}) {
  return {
    channel: 'email' as const,
    routingKey: options.routingKey ?? 'transactional',
    recipient: { email: recipient },
    content: {
      from: 'E2E Sender <sender@example.test>',
      subject: options.subject ?? `E2E ${randomUUID()}`,
      text: options.text ?? 'Plain text body from the e2e suite.',
      html: options.html ?? '<p>HTML body from the e2e suite.</p>',
    },
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
  };
}

/** Valid payloads of the channels that are representable but not enabled in the first release. */
export const futureChannelRequests = {
  sms: {
    channel: 'sms',
    routingKey: 'transactional',
    recipient: { phoneNumber: '+15555550100' },
    content: { text: 'E2E sms' },
  },
  push: {
    channel: 'push',
    routingKey: 'transactional',
    recipient: { platform: 'fcm', deviceToken: 'e2e-device-token' },
    content: { title: 'E2E', body: 'E2E push' },
  },
  messagingWhatsapp: {
    channel: 'messaging',
    routingKey: 'transactional',
    recipient: { platform: 'whatsapp', phoneNumber: '+15555550101' },
    content: { type: 'text', text: 'E2E whatsapp' },
  },
  messagingTelegram: {
    channel: 'messaging',
    routingKey: 'transactional',
    recipient: { platform: 'telegram', chatId: 'e2e-chat' },
    content: {
      type: 'template',
      templateName: 'e2e_template',
      language: 'en',
      parameters: ['a'],
    },
  },
} as const;
