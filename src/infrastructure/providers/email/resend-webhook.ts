import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  NormalizedEventType,
  NormalizedProviderEvent,
  WebhookParseResult,
} from '../../../contracts/provider-port.js';

/**
 * Resend signs webhooks with Svix: HMAC-SHA256 over `${svix-id}.${svix-timestamp}.${rawBody}`
 * keyed with the base64 part of the `whsec_` secret; `svix-signature` carries one or more
 * space-separated `v1,<base64>` entries.
 */
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;
export const WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

const SECRET_PREFIX = 'whsec_';

export type WebhookHeaders = Readonly<Record<string, string | string[] | undefined>>;

function header(headers: WebhookHeaders, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    const single = Array.isArray(value) ? value[0] : value;
    return single === undefined || single === '' ? undefined : single;
  }
  return undefined;
}

export class WebhookSecretError extends Error {
  constructor() {
    super('Webhook signing secret is not usable');
    this.name = 'WebhookSecretError';
  }
}

function signingKey(secret: string): Buffer {
  const encoded = secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret;
  const key = Buffer.from(encoded, 'base64');
  if (key.length === 0) throw new WebhookSecretError();
  return key;
}

function computeSignature(key: Buffer, id: string, timestamp: string, rawBody: Buffer): Buffer {
  return createHmac('sha256', key)
    .update(Buffer.concat([Buffer.from(`${id}.${timestamp}.`, 'utf8'), rawBody]))
    .digest();
}

/** Computes the base64 `v1` signature for a payload; exported for test fixtures. */
export function signSvixPayload(
  secret: string,
  id: string,
  timestamp: string,
  rawBody: Buffer,
): string {
  return computeSignature(signingKey(secret), id, timestamp, rawBody).toString('base64');
}

function signatureMatches(expected: Buffer, signatureHeader: string): boolean {
  let matched = false;
  for (const entry of signatureHeader.split(' ')) {
    const separator = entry.indexOf(',');
    if (separator < 0 || entry.slice(0, separator) !== 'v1') continue;
    const candidate = Buffer.from(entry.slice(separator + 1), 'base64');
    // Evaluate every entry without short-circuiting to keep timing independent of position.
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) {
      matched = true;
    }
  }
  return matched;
}

const EVENT_TYPES: Readonly<Record<string, NormalizedEventType>> = {
  'email.sent': 'accepted',
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'delivery_delayed',
  'email.complained': 'complained',
  'email.failed': 'failed',
  'email.opened': 'opened',
  'email.clicked': 'clicked',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Bounce classification: only `Transient`/`Undetermined` are soft. A missing type follows the
 * documented meaning of `email.bounced` (permanent rejection by the recipient server).
 */
function bounceType(bounce: Record<string, unknown> | undefined): NormalizedEventType {
  const type = bounce === undefined ? undefined : stringField(bounce, 'type')?.toLowerCase();
  return type === 'transient' || type === 'undetermined' ? 'bounced_soft' : 'bounced_hard';
}

const SAFE_LABEL = /^[A-Za-z0-9 ._-]{1,64}$/;

function normalizeEvent(
  body: Record<string, unknown>,
  eventId: string,
  timestampSeconds: number,
): NormalizedProviderEvent | undefined {
  const providerType = stringField(body, 'type');
  const data = body.data;
  if (providerType === undefined || !isRecord(data)) return undefined;

  const bounce = isRecord(data.bounce) ? data.bounce : undefined;
  const type =
    providerType === 'email.bounced' ? bounceType(bounce) : (EVENT_TYPES[providerType] ?? 'other');

  const createdAt = stringField(body, 'created_at');
  const parsedDate = createdAt === undefined ? Number.NaN : Date.parse(createdAt);
  const occurredAt = new Date(Number.isNaN(parsedDate) ? timestampSeconds * 1000 : parsedDate);

  // Minimized payload: only classification labels, never addresses, subjects, bodies or links.
  const payload: Record<string, unknown> = { providerEventType: providerType.slice(0, 64) };
  if (bounce !== undefined) {
    const bounceKind = stringField(bounce, 'type');
    const bounceSubType = stringField(bounce, 'subType');
    if (bounceKind !== undefined && SAFE_LABEL.test(bounceKind)) payload.bounceType = bounceKind;
    if (bounceSubType !== undefined && SAFE_LABEL.test(bounceSubType)) {
      payload.bounceSubType = bounceSubType;
    }
  }

  return {
    externalEventId: eventId,
    externalMessageId: stringField(data, 'email_id') ?? null,
    type,
    occurredAt,
    payload,
  };
}

export interface VerifyOptions {
  now?: Date;
  toleranceSeconds?: number;
}

/**
 * Verifies a Resend (Svix) webhook on the raw body and normalizes it. Duplicates are not
 * detected here: the same delivery always yields the same `externalEventId` (svix-id).
 * Throws WebhookSecretError when the configured secret is unusable.
 */
export function verifyAndParseResendWebhook(
  rawBody: Buffer,
  headers: WebhookHeaders,
  secret: string,
  options: VerifyOptions = {},
): WebhookParseResult {
  const key = signingKey(secret);
  const id = header(headers, 'svix-id');
  const timestamp = header(headers, 'svix-timestamp');
  const signature = header(headers, 'svix-signature');
  if (id === undefined || timestamp === undefined || signature === undefined) {
    return { ok: false, reason: 'invalid_signature' };
  }
  if (id.length > 256 || !/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: 'malformed' };
  if (rawBody.length > WEBHOOK_MAX_BODY_BYTES) return { ok: false, reason: 'malformed' };

  const expected = computeSignature(key, id, timestamp, rawBody);
  if (!signatureMatches(expected, signature)) return { ok: false, reason: 'invalid_signature' };

  const timestampSeconds = Number(timestamp);
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000);
  const tolerance = options.toleranceSeconds ?? WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS;
  if (Math.abs(nowSeconds - timestampSeconds) > tolerance) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!isRecord(body)) return { ok: false, reason: 'malformed' };
  const event = normalizeEvent(body, id, timestampSeconds);
  if (event === undefined) return { ok: false, reason: 'malformed' };
  return { ok: true, events: [event] };
}
