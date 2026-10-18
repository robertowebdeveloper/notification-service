export const CHANNELS = ['email', 'sms', 'push', 'messaging'] as const;
export type Channel = (typeof CHANNELS)[number];

export type PushPlatform = 'fcm' | 'apns';
export type MessagingPlatform = 'whatsapp' | 'telegram';

export interface EmailRecipient {
  email: string;
}

export interface EmailContent {
  from: string;
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
}

export interface SmsRecipient {
  /** E.164 format, e.g. +393331234567 */
  phoneNumber: string;
}

export interface SmsContent {
  text: string;
  senderId?: string;
}

export interface PushRecipient {
  platform: PushPlatform;
  deviceToken: string;
}

export interface PushContent {
  title: string;
  body: string;
  data?: Record<string, string>;
}

export type MessagingRecipient =
  { platform: 'whatsapp'; phoneNumber: string } | { platform: 'telegram'; chatId: string };

export type MessagingContent =
  | { type: 'text'; text: string }
  | { type: 'template'; templateName: string; language: string; parameters: string[] };

export interface PayloadByChannel {
  email: { recipient: EmailRecipient; content: EmailContent };
  sms: { recipient: SmsRecipient; content: SmsContent };
  push: { recipient: PushRecipient; content: PushContent };
  messaging: { recipient: MessagingRecipient; content: MessagingContent };
}

/** Discriminated union of every channel payload. */
export type ChannelPayload = {
  [C in Channel]: { channel: C } & PayloadByChannel[C];
}[Channel];

/** Platform discriminator used by routing; undefined for channels without platforms. */
export type PlatformByChannel = {
  email: undefined;
  sms: undefined;
  push: PushPlatform;
  messaging: MessagingPlatform;
};

/** Channels accepted by the API in the current release; others are rejected with 422. */
export const ENABLED_CHANNELS: ReadonlySet<Channel> = new Set<Channel>(['email']);
