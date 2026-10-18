import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from 'typebox';
import {
  ErrorBody,
  parseResourceId,
  ResourceIdParam,
  ROUTES,
} from '../../contracts/http-schemas.js';
import type { IngestWebhook } from '../../application/notifications/ingest-webhook.js';

/** Upper bound for webhook bodies (matches the provider parsers' own limit). */
export const WEBHOOK_BODY_LIMIT_BYTES = 256 * 1024;

export interface WebhookRoutesOptions {
  ingestWebhook: IngestWebhook;
}

const WebhookParams = Type.Object({
  providerType: Type.String({ pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' }),
  instanceId: ResourceIdParam,
});

const WebhookResponse = Type.Object({
  received: Type.Integer({ minimum: 0 }),
  duplicates: Type.Integer({ minimum: 0 }),
});

/**
 * Encapsulated plugin: content-type parsers are replaced only here, so the raw body reaches the
 * adapter byte-for-byte for signature verification.
 */
export const webhookRoutes: FastifyPluginAsyncTypebox<WebhookRoutesOptions> = async (app, opts) => {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser(
    '*',
    { parseAs: 'buffer', bodyLimit: WEBHOOK_BODY_LIMIT_BYTES },
    (_request, body, done) => {
      done(null, body);
    },
  );

  app.post(
    ROUTES.providerWebhook,
    {
      bodyLimit: WEBHOOK_BODY_LIMIT_BYTES,
      schema: {
        tags: ['webhooks'],
        summary: 'Provider webhook (authenticated by the provider signature)',
        description:
          `Raw body up to ${WEBHOOK_BODY_LIMIT_BYTES} bytes. Responds 200 only after the events ` +
          'are durably stored; valid duplicates also receive 200. Invalid signatures get 401. ' +
          'Rate limits (429): verified calls per instance; failed verifications per instance and ' +
          'per client IP are limited separately and never consume the verified budget.',
        params: WebhookParams,
        response: {
          200: WebhookResponse,
          401: ErrorBody,
          404: ErrorBody,
          413: ErrorBody,
          429: ErrorBody,
          503: ErrorBody,
        },
      },
    },
    async (request) => {
      const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      return opts.ingestWebhook.execute({
        providerType: request.params.providerType,
        instanceId: parseResourceId(request.params.instanceId),
        rawBody,
        headers: request.headers,
        clientIp: request.ip,
      });
    },
  );
  return Promise.resolve();
};
