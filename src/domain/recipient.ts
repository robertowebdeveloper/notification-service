import { domainToASCII } from 'node:url';
import type { ChannelPayload } from '../contracts/channels.js';

/**
 * Channel-specific recipient keys used by suppressions.
 *
 * Email normalization is deliberately non-destructive: the local part is kept byte for byte
 * (no lower-casing, no dot or `+tag` removal, since those rules are mailbox-provider specific);
 * only surrounding whitespace is trimmed and the domain, which is case-insensitive by
 * definition, is lower-cased and converted to its ASCII (IDNA) form.
 */
export function normalizeEmailAddress(address: string): string {
  const trimmed = address.trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return trimmed;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1).replace(/\.$/, '');
  const ascii = domainToASCII(domain);
  return `${local}@${(ascii === '' ? domain : ascii).toLowerCase()}`;
}

/** E.164: keep `+` and digits only (formatting characters are not significant). */
export function normalizePhoneNumber(phone: string): string {
  return phone.trim().replace(/[\s().-]/g, '');
}

export function recipientKey(payload: ChannelPayload): string {
  switch (payload.channel) {
    case 'email':
      return normalizeEmailAddress(payload.recipient.email);
    case 'sms':
      return normalizePhoneNumber(payload.recipient.phoneNumber);
    case 'push':
      return `${payload.recipient.platform}:${payload.recipient.deviceToken.trim()}`;
    case 'messaging':
      return payload.recipient.platform === 'whatsapp'
        ? `whatsapp:${normalizePhoneNumber(payload.recipient.phoneNumber)}`
        : `telegram:${payload.recipient.chatId.trim()}`;
  }
}
