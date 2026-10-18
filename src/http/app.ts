import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { LoggerOptions } from 'pino';
import { API_VERSION_PREFIX, LIMITS } from '../contracts/http-schemas.js';
import type { ApiKeyRepository } from '../application/ports/lookup-repositories.js';
import type { CreateNotification } from '../application/notifications/create-notification.js';
import type { IngestWebhook } from '../application/notifications/ingest-webhook.js';
import type { QueryNotifications } from '../application/notifications/query-notifications.js';
import type { RetryNotification } from '../application/notifications/retry-notification.js';
import type { Metrics } from '../application/ports/metrics.js';
import { errorHandler, sendError } from './errors.js';
import { createAuthenticator, type AuthenticatorGuards } from './plugins/auth.js';
import { healthRoutes, type ReadinessCheck } from './routes/health.js';
import { LIMITS_DESCRIPTION, notificationRoutes } from './routes/notifications.js';
import { webhookRoutes } from './routes/webhooks.js';

/** Use cases behind the versioned public API. */
export interface ApiDependencies {
  apiKeys: ApiKeyRepository;
  /** Pre-auth failure budget per client IP and per-tenant read limit. */
  authGuards?: AuthenticatorGuards;
  createNotification: CreateNotification;
  queryNotifications: QueryNotifications;
  retryNotification: RetryNotification;
  ingestWebhook: IngestWebhook;
  clock?: () => Date;
  metrics?: Metrics;
}

export interface AppDependencies {
  logger: LoggerOptions | false;
  readiness: ReadinessCheck;
  /** Omitted only by tests that exercise health routes alone. */
  api?: ApiDependencies;
  http?: HttpServerOptions;
}

export interface HttpServerOptions {
  /** Max time to receive a whole request from the client (slow clients). */
  requestTimeoutMs?: number;
  /**
   * Max time to process a request; on expiry the client gets 503 and `request.signal` aborts
   * (the database statement timeout bounds the abandoned work itself).
   */
  handlerTimeoutMs?: number;
  /** Fastify `trustProxy` (client IP for per-IP limits behind an ingress). */
  trustProxy?: boolean | number | string;
  /** Serve the Swagger UI on DOCS_PATH (default false). */
  docs?: boolean;
}

/** Applied when `http` is omitted, so no API request can hang forever. */
export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

export const OPENAPI_JSON_PATH = `${API_VERSION_PREFIX}/openapi.json`;
export const DOCS_PATH = `${API_VERSION_PREFIX}/docs`;

/** A hop count trusts that many proxies in front of the server (proxy-addr semantics). */
function trustProxyOption(
  value: boolean | number | string | undefined,
): boolean | string | ((address: string, hop: number) => boolean) {
  if (typeof value === 'number') return (_address: string, hop: number) => hop < value;
  return value ?? false;
}

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const http = deps.http ?? {};
  const app = Fastify({
    logger: deps.logger,
    requestTimeout: http.requestTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
    handlerTimeout: http.handlerTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
    trustProxy: trustProxyOption(http.trustProxy),
    bodyLimit: LIMITS.bodyBytes,
    genReqId: () => randomUUID(),
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, allErrors: false } },
  }).withTypeProvider<TypeBoxTypeProvider>();

  app.decorateRequest('auth', null);

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Notification Service',
        version: '0.1.0',
        description:
          `Asynchronous notifications API. Authentication: \`Authorization: Bearer <api-key>\` ` +
          `(tenant derived from the key). Errors use \`{ code, message, requestId, details? }\`. ` +
          LIMITS_DESCRIPTION,
      },
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
      },
    },
  });

  if (http.docs === true) {
    // Static UI only: it reads the same document as OPENAPI_JSON_PATH and calls no API itself
    // unless the user runs "Try it out" with their own key.
    await app.register(swaggerUi, {
      routePrefix: DOCS_PATH,
      staticCSP: true,
      uiConfig: { docExpansion: 'list', deepLinking: true, persistAuthorization: false },
    });
  }

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((request, reply) =>
    sendError(reply, request, 404, 'not_found', 'Not found'),
  );

  await app.register(healthRoutes, { readiness: deps.readiness });

  if (deps.api !== undefined) {
    const api = deps.api;
    await app.register(notificationRoutes, {
      auth: createAuthenticator(api.apiKeys, api.clock, api.authGuards),
      createNotification: api.createNotification,
      queryNotifications: api.queryNotifications,
      retryNotification: api.retryNotification,
      ...(api.metrics === undefined ? {} : { metrics: api.metrics }),
    });
    await app.register(webhookRoutes, { ingestWebhook: api.ingestWebhook });
  }

  app.get(OPENAPI_JSON_PATH, { schema: { hide: true } }, () => app.swagger());
  return app;
}
