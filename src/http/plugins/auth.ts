import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import type {
  FailureBudget,
  IngressLimiter,
} from '../../application/notifications/ingress-guards.js';
import type { ApiKeyRepository } from '../../application/ports/lookup-repositories.js';
import type { ApiScope } from '../../contracts/statuses.js';
import { parseApiKey, verifyApiKey } from '../../infrastructure/security/api-keys.js';
import { sendError } from '../errors.js';

export interface AuthContext {
  apiKeyId: string;
  /** Always derived from the API key, never from the request. */
  tenantId: string;
  scopes: readonly ApiScope[];
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

const TOUCH_INTERVAL_MS = 60_000;
const UNAUTHORIZED = 'Missing or invalid API key';

export interface Authenticator {
  /** onRequest hook: 401 for missing/invalid/revoked/expired keys or inactive tenant, 403 for scope. */
  require(scope: ApiScope): onRequestAsyncHookHandler;
}

export interface AuthenticatorGuards {
  /**
   * Failed authentications per client IP (`AUTH_FAILURE_RATE_*`): checked before the API key
   * lookup, charged only on failure, so valid clients never consume it.
   */
  failures?: FailureBudget | null;
  /** Per-tenant limit applied to routes requiring `notifications:read` (`READ_RATE_*`). */
  reads?: IngressLimiter | null;
}

export function createAuthenticator(
  apiKeys: ApiKeyRepository,
  now: () => Date = () => new Date(),
  guards: AuthenticatorGuards = {},
): Authenticator {
  const lastTouched = new Map<string, number>();

  function touch(request: FastifyRequest, apiKeyId: string, at: Date): void {
    const previous = lastTouched.get(apiKeyId) ?? 0;
    if (at.getTime() - previous < TOUCH_INTERVAL_MS) return;
    lastTouched.set(apiKeyId, at.getTime());
    apiKeys.touchLastUsed(apiKeyId, at).catch((err: unknown) => {
      request.log.warn({ err }, 'cannot update api key last_used_at');
    });
  }

  async function authenticate(request: FastifyRequest): Promise<AuthContext | null> {
    const header = request.headers.authorization;
    if (typeof header !== 'string') return null;
    const match = /^Bearer ([^\s]{1,256})$/i.exec(header.trim());
    const presented = match?.[1];
    if (presented === undefined) return null;
    const parsed = parseApiKey(presented);
    if (parsed === null) return null;

    const record = await apiKeys.findByPrefix(parsed.keyPrefix);
    if (!verifyApiKey(presented, record?.keyHash ?? null) || record === null) return null;
    const at = now();
    if (record.revokedAt !== null && record.revokedAt <= at) return null;
    if (record.expiresAt !== null && record.expiresAt <= at) return null;
    if (!record.tenantActive) return null;
    touch(request, record.id, at);
    return { apiKeyId: record.id, tenantId: record.tenantId, scopes: record.scopes };
  }

  return {
    require(scope) {
      return async (request: FastifyRequest, reply: FastifyReply) => {
        // Throws 429 (handled by the error handler) before touching the database.
        await guards.failures?.assertNotExhausted(request.ip);
        const auth = await authenticate(request);
        if (auth === null) {
          await guards.failures?.recordFailure(request.ip);
          return sendError(reply, request, 401, 'unauthorized', UNAUTHORIZED);
        }
        if (!auth.scopes.includes(scope)) {
          return sendError(reply, request, 403, 'forbidden', `Missing scope ${scope}`);
        }
        request.auth = auth;
        if (scope === 'notifications:read') await guards.reads?.check(auth.tenantId);
        return undefined;
      };
    },
  };
}

/** Narrowing helper for handlers behind `require(...)`. */
export function authOf(request: FastifyRequest): AuthContext {
  if (request.auth === null) throw new Error('route is missing the authentication hook');
  return request.auth;
}
