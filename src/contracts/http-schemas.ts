import { Type, type Static } from 'typebox';
import { SUBMISSION_STATUSES, RECEIPT_STATUSES } from './statuses.js';
import { CHANNELS } from './channels.js';
import { MAILBOX_PATTERN_SOURCE } from './email-address.js';

export const LIMITS = {
  bodyBytes: 256 * 1024,
  metadataBytes: 4 * 1024,
  idempotencyKeyMaxLength: 255,
  subjectMaxLength: 998,
} as const;

const NonEmpty = (maxLength: number) => Type.String({ minLength: 1, maxLength });
const strict = { additionalProperties: false } as const;

const Metadata = Type.Record(
  Type.String({ maxLength: 64 }),
  Type.Union([Type.String({ maxLength: 1024 }), Type.Number(), Type.Boolean()]),
  { maxProperties: 32, description: `Serialized size limited to ${LIMITS.metadataBytes} bytes` },
);

const RoutingKey = Type.String({ pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' });

export const EmailNotificationBody = Type.Object(
  {
    channel: Type.Literal('email'),
    routingKey: RoutingKey,
    recipient: Type.Object({ email: Type.String({ format: 'email', maxLength: 320 }) }, strict),
    content: Type.Object(
      {
        /** Exactly one mailbox: `user@domain`, `Name <user@domain>` or `"Name" <user@domain>`. */
        from: Type.String({
          minLength: 3,
          maxLength: 320,
          pattern: MAILBOX_PATTERN_SOURCE,
          description:
            'Exactly one sender mailbox (`user@domain`, `Name <user@domain>` or ' +
            '`"Name" <user@domain>`); lists, groups and line breaks are rejected',
        }),
        subject: NonEmpty(LIMITS.subjectMaxLength),
        text: Type.Optional(NonEmpty(LIMITS.bodyBytes)),
        html: Type.Optional(NonEmpty(LIMITS.bodyBytes)),
        replyTo: Type.Optional(Type.String({ format: 'email', maxLength: 320 })),
      },
      { ...strict, description: 'At least one of text or html is required' },
    ),
    metadata: Type.Optional(Metadata),
  },
  strict,
);

export const SmsNotificationBody = Type.Object(
  {
    channel: Type.Literal('sms'),
    routingKey: RoutingKey,
    recipient: Type.Object(
      { phoneNumber: Type.String({ pattern: '^\\+[1-9][0-9]{6,14}$' }) },
      strict,
    ),
    content: Type.Object({ text: NonEmpty(1600), senderId: Type.Optional(NonEmpty(16)) }, strict),
    metadata: Type.Optional(Metadata),
  },
  strict,
);

export const PushNotificationBody = Type.Object(
  {
    channel: Type.Literal('push'),
    routingKey: RoutingKey,
    recipient: Type.Object(
      {
        platform: Type.Union([Type.Literal('fcm'), Type.Literal('apns')]),
        deviceToken: NonEmpty(4096),
      },
      strict,
    ),
    content: Type.Object(
      {
        title: NonEmpty(256),
        body: NonEmpty(4096),
        data: Type.Optional(
          Type.Record(Type.String({ maxLength: 64 }), Type.String({ maxLength: 1024 })),
        ),
      },
      strict,
    ),
    metadata: Type.Optional(Metadata),
  },
  strict,
);

export const MessagingNotificationBody = Type.Object(
  {
    channel: Type.Literal('messaging'),
    routingKey: RoutingKey,
    recipient: Type.Union([
      Type.Object(
        {
          platform: Type.Literal('whatsapp'),
          phoneNumber: Type.String({ pattern: '^\\+[1-9][0-9]{6,14}$' }),
        },
        strict,
      ),
      Type.Object({ platform: Type.Literal('telegram'), chatId: NonEmpty(64) }, strict),
    ]),
    content: Type.Union([
      Type.Object({ type: Type.Literal('text'), text: NonEmpty(4096) }, strict),
      Type.Object(
        {
          type: Type.Literal('template'),
          templateName: NonEmpty(512),
          language: NonEmpty(16),
          parameters: Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 32 }),
        },
        strict,
      ),
    ]),
    metadata: Type.Optional(Metadata),
  },
  strict,
);

export const CreateNotificationBody = Type.Union([
  EmailNotificationBody,
  SmsNotificationBody,
  PushNotificationBody,
  MessagingNotificationBody,
]);
export type CreateNotificationBody = Static<typeof CreateNotificationBody>;

export const IdempotencyHeaders = Type.Object({
  'idempotency-key': Type.String({ minLength: 1, maxLength: LIMITS.idempotencyKeyMaxLength }),
});

/** Resource ids are PostgreSQL bigint identity values (exact as JSON numbers up to 2^53 - 1). */
export const ResourceId = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });

/**
 * Resource id in a path segment. Type coercion is disabled (bodies are validated strictly), so
 * the segment is validated as a decimal string and converted with `parseResourceId`.
 */
export const ResourceIdParam = Type.String({
  pattern: '^[1-9][0-9]{0,15}$',
  description: 'Positive integer id',
  examples: ['42'],
});

/**
 * Path id as a number. Ids beyond 2^53 - 1 cannot exist: they map to 0, which matches no row
 * (identities start at 1), so callers take their usual not-found path, abuse budgets included.
 */
export function parseResourceId(segment: string): number {
  const id = Number(segment);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

export const CreateNotificationResponse = Type.Object({
  id: ResourceId,
  submissionStatus: Type.Literal('pending'),
});
export type CreateNotificationResponse = Static<typeof CreateNotificationResponse>;

const DateTime = Type.String({ format: 'date-time' });

export const RetryNotificationResponse = Type.Object({
  id: ResourceId,
  submissionStatus: Type.Literal('retry_wait'),
  generation: Type.Integer({ minimum: 1 }),
});
export type RetryNotificationResponse = Static<typeof RetryNotificationResponse>;

export const NotificationView = Type.Object({
  id: ResourceId,
  channel: Type.Enum(CHANNELS),
  /** Channel platform (push/messaging), null for email and sms. */
  platform: Type.Union([Type.String(), Type.Null()]),
  routingKey: Type.String(),
  submissionStatus: Type.Enum(SUBMISSION_STATUSES),
  receiptStatus: Type.Enum(RECEIPT_STATUSES),
  createdAt: DateTime,
  updatedAt: DateTime,
  attempts: Type.Array(
    Type.Object({
      number: Type.Integer(),
      outcome: Type.String(),
      startedAt: DateTime,
      finishedAt: Type.Union([DateTime, Type.Null()]),
      errorCode: Type.Union([Type.String(), Type.Null()]),
    }),
  ),
  lastError: Type.Union([
    Type.Object({ code: Type.String(), message: Type.String() }),
    Type.Null(),
  ]),
});
export type NotificationView = Static<typeof NotificationView>;

export const ListNotificationsQuery = Type.Object(
  {
    status: Type.Optional(Type.Enum(SUBMISSION_STATUSES)),
    channel: Type.Optional(Type.Enum(CHANNELS)),
    createdFrom: Type.Optional(DateTime),
    createdTo: Type.Optional(DateTime),
    cursor: Type.Optional(Type.String({ maxLength: 512 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 25 })),
  },
  strict,
);
export type ListNotificationsQuery = Static<typeof ListNotificationsQuery>;

export const ERROR_CODES = [
  'validation_error',
  'payload_too_large',
  'unauthorized',
  'forbidden',
  'not_found',
  'idempotency_conflict',
  'conflict',
  'channel_not_enabled',
  'no_compatible_route',
  'rate_limited',
  'dependency_unavailable',
  'internal_error',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ErrorBody = Type.Object({
  code: Type.Enum(ERROR_CODES),
  message: Type.String(),
  requestId: Type.String(),
  details: Type.Optional(Type.Unknown()),
});
export type ErrorBody = Static<typeof ErrorBody>;

/** Every public route is versioned; breaking changes go to a new prefix (e.g. /v2). */
export const API_VERSION_PREFIX = '/v1';
export const ROUTES = {
  notifications: `${API_VERSION_PREFIX}/notifications`,
  notificationById: `${API_VERSION_PREFIX}/notifications/:id`,
  notificationRetry: `${API_VERSION_PREFIX}/notifications/:id/retry`,
  providerWebhook: `${API_VERSION_PREFIX}/webhooks/:providerType/:instanceId`,
} as const;
