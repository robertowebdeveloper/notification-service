import {
  pino,
  stdSerializers,
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from 'pino';
import type { AppConfig } from '../../config/env.js';

export const REDACTED = '[redacted]';

/**
 * Keys whose value is never logged: credentials, recipients and message content. Matched at the
 * top level and up to two levels deep (three for credentials; pino paths are not recursive): log
 * identifiers, durations, outcomes and sanitized codes instead of whole payloads or provider objects.
 */
const CREDENTIAL_KEYS = [
  'authorization',
  'cookie',
  'apiKey',
  'api_key',
  'password',
  'pass',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'secrets',
  'clientSecret',
  'privateKey',
  'signingSecret',
  'webhookSecret',
] as const;

export const SENSITIVE_KEYS = [
  ...CREDENTIAL_KEYS,
  // recipients (EmailRecipient, SmsRecipient, PushRecipient, MessagingRecipient, SMTP envelope)
  'recipient',
  'recipients',
  'to',
  'cc',
  'bcc',
  'replyTo',
  'email',
  'phone',
  'phoneNumber',
  'deviceToken',
  'chatId',
  'envelope',
  // content (EmailContent, SmsContent, PushContent, MessagingContent)
  'content',
  'subject',
  'html',
  'text',
  'body',
  'title',
  'parameters',
] as const;

/** Credential-bearing HTTP headers (webhook signatures included). */
export const SENSITIVE_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'svix-signature',
  'webhook-signature',
  'resend-signature',
] as const;

function headerPaths(prefix: string): string[] {
  return SENSITIVE_HEADERS.map((h) => `${prefix}headers["${h}"]`);
}

export const REDACT_PATHS: readonly string[] = [
  ...SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
  // Credentials also one level deeper (e.g. instance.config.auth.pass).
  ...CREDENTIAL_KEYS.map((key) => `*.*.*.${key}`),
  ...headerPaths(''),
  ...headerPaths('*.'),
  ...headerPaths('*.*.'),
];

/** Keys stripped from error objects: nodemailer attaches the envelope and recipient lists. */
const ERROR_SENSITIVE_KEYS = new Set(
  [...SENSITIVE_KEYS, 'accepted', 'rejected', 'rejectedErrors', 'pending', 'headers'].map((k) =>
    k.toLowerCase(),
  ),
);

const TEXT_SCRUBBERS: readonly [RegExp, string][] = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
  [/\bns_[0-9a-f]{12}_[A-Za-z0-9_-]{43}/g, '[api-key]'],
  [/\bre_[A-Za-z0-9_]{16,}/g, '[api-key]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '[email]'],
  [/\+\d[\d\s().-]{6,18}\d/g, '[phone]'],
];

/**
 * Removes recipients and credentials embedded in free text (provider error messages such as
 * `550 5.1.1 <user@example.com>: Recipient address rejected`).
 */
export function scrubText(value: string): string {
  let out = value;
  for (const [pattern, replacement] of TEXT_SCRUBBERS) out = out.replace(pattern, replacement);
  return out;
}

const MAX_DEPTH = 6;

function scrubValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return scrubText(value);
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value) || depth >= MAX_DEPTH) return '[truncated]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, depth + 1, seen));
  if (value instanceof Error) return scrubValue(stdSerializers.err(value), depth, seen);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = ERROR_SENSITIVE_KEYS.has(key.toLowerCase())
      ? REDACTED
      : scrubValue(item, depth + 1, seen);
  }
  return out;
}

/**
 * `err` serializer: standard pino error shape, then free-text scrubbing of message/stack and
 * removal of recipient/credential properties at any depth. Also accepts plain strings and
 * objects, since call sites log `err: error.message` as well.
 */
export function serializeError(value: unknown): unknown {
  if (value instanceof Error) return scrubValue(stdSerializers.err(value), 0, new WeakSet());
  return scrubValue(value, 0, new WeakSet());
}

export function loggerOptions(config: Pick<AppConfig, 'LOG_LEVEL'>, role: string): LoggerOptions {
  return {
    level: config.LOG_LEVEL,
    base: { role },
    redact: { paths: [...REDACT_PATHS], censor: REDACTED },
    serializers: { err: serializeError, error: serializeError },
  };
}

export function createLogger(
  config: Pick<AppConfig, 'LOG_LEVEL'>,
  role: string,
  destination?: DestinationStream,
): Logger {
  const options = loggerOptions(config, role);
  return destination === undefined ? pino(options) : pino(options, destination);
}
