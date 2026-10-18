import type {
  ProviderError,
  ProviderErrorKind,
  SendResult,
} from '../../contracts/provider-port.js';

/**
 * Sanitized, provider-agnostic codes used by every adapter. They never carry provider
 * messages, recipient addresses or other PII.
 */
export const PROVIDER_ERROR_CODES = {
  aborted: 'aborted',
  timeout: 'timeout',
  connectionFailed: 'connection_failed',
  tlsFailed: 'tls_failed',
  authenticationFailed: 'authentication_failed',
  senderRejected: 'sender_rejected',
  recipientRejected: 'recipient_rejected',
  messageRejected: 'message_rejected',
  invalidRequest: 'invalid_request',
  rateLimited: 'rate_limited',
  configurationInvalid: 'configuration_invalid',
  missingSecret: 'missing_secret',
} as const;
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[keyof typeof PROVIDER_ERROR_CODES];

/** Reasons attached to `unknown` outcomes: the provider may have accepted the message. */
export const UNKNOWN_REASONS = {
  timeoutAfterSubmission: 'timeout_after_submission',
  abortedAfterSubmission: 'aborted_after_submission',
  connectionLostAfterSubmission: 'connection_lost_after_submission',
  unparsableResponse: 'unparsable_response',
  providerServerError: 'provider_server_error',
  unexpectedStatus: 'unexpected_status',
  idempotencyRequestInProgress: 'idempotency_request_in_progress',
  idempotencyKeyConflict: 'idempotency_key_conflict',
} as const;
export type UnknownReason = (typeof UNKNOWN_REASONS)[keyof typeof UNKNOWN_REASONS];

export const DEFAULT_SEND_TIMEOUT_MS = 15_000;

interface RejectOptions {
  retryAfterMs?: number | undefined;
  /** Defaults to true: adapters only reject when non-acceptance is certain. */
  definitelyNotAccepted?: boolean;
}

export function rejected(
  kind: ProviderErrorKind,
  code: ProviderErrorCode,
  message: string,
  options: RejectOptions = {},
): SendResult {
  const error: ProviderError = {
    kind,
    code,
    message,
    definitelyNotAccepted: options.definitelyNotAccepted ?? true,
  };
  if (options.retryAfterMs !== undefined) error.retryAfterMs = options.retryAfterMs;
  return { outcome: 'rejected', error };
}

export function unknownOutcome(reason: UnknownReason, externalReference?: string): SendResult {
  return externalReference === undefined
    ? { outcome: 'unknown', reason }
    : { outcome: 'unknown', reason, externalReference };
}

export function abortedBeforeSubmission(): SendResult {
  return rejected('retryable', PROVIDER_ERROR_CODES.aborted, 'Send aborted before submission');
}

export function missingSecret(key: string): SendResult {
  return rejected(
    'configuration',
    PROVIDER_ERROR_CODES.missingSecret,
    `Provider instance secret "${key}" is not available`,
  );
}

/** Reads a resolved secret without ever exposing its value in errors. */
export function readSecret(secrets: ReadonlyMap<string, string>, key: string): string | undefined {
  const value = secrets.get(key);
  return value === undefined || value === '' ? undefined : value;
}
