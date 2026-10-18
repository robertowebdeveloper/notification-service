import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Type } from 'typebox';
import {
  CreateNotificationBody,
  CreateNotificationResponse,
  ErrorBody,
  IdempotencyHeaders,
  LIMITS,
  ListNotificationsQuery,
  NotificationView,
  RetryNotificationResponse,
  ROUTES,
  API_VERSION_PREFIX,
} from '../../contracts/http-schemas.js';
import type { CreateNotification } from '../../application/notifications/create-notification.js';
import type { QueryNotifications } from '../../application/notifications/query-notifications.js';
import type { RetryNotification } from '../../application/notifications/retry-notification.js';
import type { ApiOperation, Metrics } from '../../application/ports/metrics.js';
import { noopMetrics } from '../../application/ports/metrics.js';
import { codeForStatus, sentErrorCode } from '../errors.js';
import { authOf, type Authenticator } from '../plugins/auth.js';

export interface NotificationRoutesOptions {
  auth: Authenticator;
  createNotification: CreateNotification;
  queryNotifications: QueryNotifications;
  retryNotification: RetryNotification;
  metrics?: Metrics;
}

const security = [{ bearerAuth: [] }];
const tags = ['notifications'];
const IdParams = Type.Object({ id: Type.String({ format: 'uuid' }) });

const errors = (...statuses: number[]) =>
  Object.fromEntries(statuses.map((s) => [s, { ...ErrorBody, description: 'Error' }]));

const NotificationSummaryView = Type.Omit(NotificationView, ['attempts', 'lastError']);
const NotificationListResponse = Type.Object({
  items: Type.Array(NotificationSummaryView),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});

export const LIMITS_DESCRIPTION =
  `Limits: request body ≤ ${LIMITS.bodyBytes} bytes, metadata ≤ ${LIMITS.metadataBytes} bytes ` +
  `serialized, single recipient, sender must be allowed for the tenant, email requires text ` +
  `or html, unknown fields/attachments/arbitrary headers/provider URLs are rejected. ` +
  `Idempotency-Key (≤ ${LIMITS.idempotencyKeyMaxLength} chars) is required and scoped to the ` +
  `tenant; keys are retained for at least 30 days.`;

/** onResponse hook: every outcome of a write route, including auth and validation errors. */
function recordOutcome(metrics: Metrics, operation: ApiOperation) {
  return (request: FastifyRequest, reply: FastifyReply, done: () => void): void => {
    if (reply.statusCode === 202) metrics.apiRequestAccepted(operation);
    else {
      const reason = sentErrorCode(request) ?? codeForStatus(reply.statusCode);
      metrics.apiRequestRejected(operation, reason);
    }
    done();
  };
}

function locationOf(id: string): string {
  return `${API_VERSION_PREFIX}/notifications/${id}`;
}

export const notificationRoutes: FastifyPluginAsyncTypebox<NotificationRoutesOptions> = async (
  app,
  opts,
) => {
  const metrics = opts.metrics ?? noopMetrics;
  app.post(
    ROUTES.notifications,
    {
      onRequest: opts.auth.require('notifications:write'),
      onResponse: recordOutcome(metrics, 'create_notification'),
      schema: {
        tags,
        security,
        summary: 'Submit a notification',
        description: LIMITS_DESCRIPTION,
        headers: IdempotencyHeaders,
        body: CreateNotificationBody,
        response: {
          202: CreateNotificationResponse,
          ...errors(400, 401, 403, 409, 413, 422, 429, 503),
        },
      },
    },
    async (request, reply) => {
      const auth = authOf(request);
      const outcome = await opts.createNotification.execute({
        tenantId: auth.tenantId,
        idempotencyKey: request.headers['idempotency-key'],
        body: request.body,
      });
      if (outcome.replayed) void reply.header('idempotent-replayed', 'true');
      return reply
        .status(202)
        .header('location', locationOf(outcome.notificationId))
        .send({ id: outcome.notificationId, submissionStatus: 'pending' as const });
    },
  );

  app.get(
    ROUTES.notificationById,
    {
      onRequest: opts.auth.require('notifications:read'),
      schema: {
        tags,
        security,
        summary: 'Read a notification with attempts and last sanitized error',
        params: IdParams,
        response: { 200: NotificationView, ...errors(400, 401, 403, 404, 429, 503) },
      },
    },
    async (request) => {
      const auth = authOf(request);
      return opts.queryNotifications.get(auth.tenantId, request.params.id);
    },
  );

  app.get(
    ROUTES.notifications,
    {
      onRequest: opts.auth.require('notifications:read'),
      // Type coercion is disabled globally (bodies must be exact); query strings are text.
      preValidation: (request, _reply, done) => {
        const query = request.query as Record<string, unknown>;
        if (typeof query.limit === 'string' && /^[0-9]{1,4}$/.test(query.limit)) {
          query.limit = Number(query.limit);
        }
        done();
      },
      schema: {
        tags,
        security,
        summary: 'List notifications (newest first, cursor pagination)',
        querystring: ListNotificationsQuery,
        response: { 200: NotificationListResponse, ...errors(400, 401, 403, 429, 503) },
      },
    },
    async (request) => {
      const auth = authOf(request);
      return opts.queryNotifications.list(auth.tenantId, request.query);
    },
  );

  app.post(
    ROUTES.notificationRetry,
    {
      onRequest: opts.auth.require('notifications:retry'),
      onResponse: recordOutcome(metrics, 'retry_notification'),
      schema: {
        tags,
        security,
        summary: 'Manually retry a failed notification',
        description:
          'Only `failed` notifications whose attempts were all definitely rejected are retried, ' +
          'with a new attempt budget. Accepted, unknown, suppressed and in-progress ' +
          'notifications return 409. Requires its own Idempotency-Key.',
        headers: IdempotencyHeaders,
        params: IdParams,
        response: {
          202: RetryNotificationResponse,
          ...errors(400, 401, 403, 404, 409, 413, 429, 503),
        },
      },
    },
    async (request, reply) => {
      const auth = authOf(request);
      const outcome = await opts.retryNotification.execute({
        tenantId: auth.tenantId,
        apiKeyId: auth.apiKeyId,
        notificationId: request.params.id,
        idempotencyKey: request.headers['idempotency-key'],
      });
      if (outcome.replayed) void reply.header('idempotent-replayed', 'true');
      return reply
        .status(202)
        .header('location', locationOf(outcome.notificationId))
        .send({
          id: outcome.notificationId,
          submissionStatus: 'retry_wait' as const,
          generation: outcome.generation,
        });
    },
  );
  return Promise.resolve();
};
