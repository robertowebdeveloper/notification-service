/**
 * Ports owned by the notifications API use cases (in addition to the shared repository ports).
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Milliseconds until the current window resets (meaningful when not allowed). */
  retryAfterMs: number;
}

/**
 * Atomic shared counter. Implementations must not throw for infrastructure failures they
 * choose to tolerate: the caller treats a thrown error as "limiter unavailable" (fail open).
 */
export interface RateLimiter {
  consume(key: string, limit: number, windowMs: number): Promise<RateLimitDecision>;
  /**
   * Reads the current window without counting: `allowed` is false once `limit` hits were
   * recorded. Optional: without it, budgets that are only charged on failures cannot be checked
   * up front (the request is then allowed).
   */
  peek?(key: string, limit: number): Promise<RateLimitDecision>;
}

/** Senders a tenant may use in `content.from` (managed by operators via config:apply). */
export interface SenderPolicyRepository {
  allowedSenders(tenantId: string): Promise<readonly string[]>;
}

export type Clock = () => Date;
