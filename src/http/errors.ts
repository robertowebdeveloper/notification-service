import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { ErrorBody, ErrorCode } from '../contracts/http-schemas.js';
import { ApplicationError } from '../application/notifications/errors.js';

export const STATUS_BY_CODE: Readonly<Record<ErrorCode, number>> = {
  validation_error: 400,
  payload_too_large: 413,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  idempotency_conflict: 409,
  conflict: 409,
  channel_not_enabled: 422,
  no_compatible_route: 422,
  rate_limited: 429,
  dependency_unavailable: 503,
  internal_error: 500,
};

/** Error code sent for a request, read by metrics hooks after the response. */
const SENT_CODES = new WeakMap<FastifyRequest, ErrorCode>();

export function sentErrorCode(request: FastifyRequest): ErrorCode | undefined {
  return SENT_CODES.get(request);
}

export function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 413:
      return 'payload_too_large';
    case 429:
      return 'rate_limited';
    case 503:
      return 'dependency_unavailable';
    default:
      return status >= 500 ? 'internal_error' : 'validation_error';
  }
}

export function sendError(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  code: ErrorCode,
  message: string,
  details?: unknown,
): FastifyReply {
  const body: ErrorBody = {
    code,
    message,
    requestId: request.id,
    ...(details === undefined ? {} : { details }),
  };
  if (status === 401) void reply.header('www-authenticate', 'Bearer');
  SENT_CODES.set(request, code);
  return reply.status(status).send(body);
}

interface ValidationIssue {
  instancePath?: string;
  message?: string;
  params?: unknown;
}

function sanitizeValidation(issues: unknown, context: string | undefined): unknown {
  if (!Array.isArray(issues)) return undefined;
  return issues.slice(0, 20).map((issue: ValidationIssue) => ({
    in: context ?? 'body',
    instancePath: issue.instancePath ?? '',
    message: issue.message ?? 'invalid',
  }));
}

/** Maps every failure to the uniform `{ code, message, requestId, details? }` body. */
export function errorHandler(
  error: FastifyError | ApplicationError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  if (error instanceof ApplicationError) {
    const status = STATUS_BY_CODE[error.code];
    if (error.retryAfterSeconds !== undefined) {
      void reply.header('retry-after', String(error.retryAfterSeconds));
    }
    if (status >= 500) request.log.warn({ code: error.code }, error.message);
    return sendError(reply, request, status, error.code, error.message, error.details);
  }
  const fastifyError = error as FastifyError;
  if (fastifyError.validation !== undefined) {
    return sendError(
      reply,
      request,
      400,
      'validation_error',
      'Request validation failed',
      sanitizeValidation(fastifyError.validation, fastifyError.validationContext),
    );
  }
  if (fastifyError.code === 'FST_ERR_HANDLER_TIMEOUT') {
    request.log.warn({ code: fastifyError.code }, 'request processing timed out');
    return sendError(
      reply,
      request,
      503,
      'dependency_unavailable',
      'Request timed out, retry later',
    );
  }
  const status = fastifyError.statusCode ?? 500;
  if (status >= 500) {
    request.log.error({ err: error }, 'request failed');
    return sendError(reply, request, 500, 'internal_error', 'Internal error');
  }
  return sendError(reply, request, status, codeForStatus(status), fastifyError.message);
}
