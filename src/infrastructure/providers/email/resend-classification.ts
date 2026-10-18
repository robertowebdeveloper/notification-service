import type { SendResult } from '../../../contracts/provider-port.js';
import {
  PROVIDER_ERROR_CODES as CODES,
  UNKNOWN_REASONS,
  rejected,
  unknownOutcome,
} from '../send-results.js';

const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/** Parses `Retry-After` (delta seconds or HTTP-date); falls back to `ratelimit-reset` seconds. */
export function parseRetryAfterMs(headers: Headers, now: Date = new Date()): number | undefined {
  const clamp = (ms: number) => Math.min(Math.max(0, Math.ceil(ms)), MAX_RETRY_AFTER_MS);
  const retryAfter = headers.get('retry-after')?.trim();
  if (retryAfter !== undefined && retryAfter !== '') {
    if (/^\d+(\.\d+)?$/.test(retryAfter)) return clamp(Number(retryAfter) * 1000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return clamp(date - now.getTime());
  }
  const reset = headers.get('ratelimit-reset')?.trim();
  if (reset !== undefined && /^\d+$/.test(reset)) return clamp(Number(reset) * 1000);
  return undefined;
}

/**
 * Classifies a non-2xx Resend response. `errorName` is Resend's machine-readable error name
 * (never surfaced: only used to pick between documented 409 variants).
 *
 * 409 choice: both idempotency conflicts mean a request with the same key already exists and
 * may have been (or is being) accepted, so the outcome is `unknown`, never a certain rejection:
 * - `concurrent_idempotent_requests`: the original request is still in flight; a later replay
 *   with the same key inside the window returns its result.
 * - `invalid_idempotent_request` (same key, different payload): indicates a bug or a changed
 *   snapshot; it needs operator reconciliation, not a fallback.
 */
export function classifyResendStatus(
  status: number,
  headers: Headers,
  errorName: string | undefined,
): SendResult {
  if (status === 400 || status === 422) {
    return rejected(
      'permanent',
      CODES.invalidRequest,
      `Provider rejected the request (HTTP ${status})`,
    );
  }
  if (status === 413) {
    return rejected('permanent', CODES.invalidRequest, 'Provider rejected the request size');
  }
  if (status === 401) {
    return rejected('configuration', CODES.authenticationFailed, 'Provider rejected the API key');
  }
  if (status === 403) {
    return rejected(
      'configuration',
      CODES.configurationInvalid,
      'Provider refused the operation for this account (HTTP 403)',
    );
  }
  if (status === 404 || status === 405) {
    return rejected(
      'configuration',
      CODES.configurationInvalid,
      `Provider endpoint is not available (HTTP ${status})`,
    );
  }
  if (status === 409) {
    return unknownOutcome(
      errorName === 'concurrent_idempotent_requests'
        ? UNKNOWN_REASONS.idempotencyRequestInProgress
        : UNKNOWN_REASONS.idempotencyKeyConflict,
    );
  }
  if (status === 429) {
    return rejected('retryable', CODES.rateLimited, 'Provider rate limit exceeded', {
      retryAfterMs: parseRetryAfterMs(headers),
    });
  }
  if (status >= 500) return unknownOutcome(UNKNOWN_REASONS.providerServerError);
  return unknownOutcome(UNKNOWN_REASONS.unexpectedStatus);
}

/** Network error codes raised before any request byte can have reached the provider. */
const PRE_REQUEST_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EAI_NONAME',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function isTlsCode(code: string): boolean {
  return (
    code.startsWith('ERR_TLS_') ||
    code.startsWith('ERR_SSL_') ||
    code.startsWith('CERT_') ||
    code.includes('SELF_SIGNED_CERT') ||
    code.startsWith('UNABLE_TO_')
  );
}

function errorCodes(error: unknown): string[] {
  if (typeof error !== 'object' || error === null) return [];
  const codes: string[] = [];
  const { code, errors } = error as { code?: unknown; errors?: unknown };
  if (Array.isArray(errors) && errors.length > 0) {
    // AggregateError (happy eyeballs): definite only if every attempt failed before sending.
    for (const nested of errors) {
      const nestedCodes = errorCodes(nested);
      if (nestedCodes.length === 0) return [];
      codes.push(...nestedCodes);
    }
    return codes;
  }
  return typeof code === 'string' ? [code] : [];
}

/**
 * Classifies a `fetch` failure (no HTTP response). Only failures that certainly happened
 * before the request was transmitted become definite rejections; anything else is `unknown`.
 */
export function classifyFetchFailure(
  error: unknown,
  interruption: 'timeout' | 'aborted' | undefined,
): SendResult {
  if (interruption === 'timeout') return unknownOutcome(UNKNOWN_REASONS.timeoutAfterSubmission);
  if (interruption === 'aborted') return unknownOutcome(UNKNOWN_REASONS.abortedAfterSubmission);

  const cause = error instanceof Error ? error.cause : undefined;
  const codes = errorCodes(cause);
  if (codes.length > 0 && codes.every((code) => isTlsCode(code))) {
    return rejected('retryable', CODES.tlsFailed, 'TLS negotiation with the provider failed');
  }
  if (codes.length > 0 && codes.every((code) => PRE_REQUEST_CODES.has(code) || isTlsCode(code))) {
    return rejected('retryable', CODES.connectionFailed, 'Provider endpoint is not reachable');
  }
  return unknownOutcome(UNKNOWN_REASONS.connectionLostAfterSubmission);
}
