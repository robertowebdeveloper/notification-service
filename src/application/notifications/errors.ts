import type { ErrorCode } from '../../contracts/http-schemas.js';

/** Expected business failure; the HTTP layer maps `code` to a status and the uniform body. */
export class ApplicationError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
    /** Optional Retry-After hint in seconds (429/503). */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'ApplicationError';
  }
}
