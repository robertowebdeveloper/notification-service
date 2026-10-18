import type { Logger } from 'pino';
import type {
  ApiKeyRepository,
  ProviderConfigRepository,
  ProviderEventRepository,
} from '../application/ports/lookup-repositories.js';
import type {
  ManualRetryRepository,
  NotificationRepository,
} from '../application/ports/repositories.js';
import {
  CreateNotification,
  type CapabilityChecker,
} from '../application/notifications/create-notification.js';
import {
  IngestWebhook,
  type WebhookAdapterSource,
  type WebhookSecretSource,
} from '../application/notifications/ingest-webhook.js';
import {
  type BacklogGuard,
  FailureBudget,
  IngressLimiter,
  type IngressRateLimit,
} from '../application/notifications/ingress-guards.js';
import type {
  Clock,
  RateLimiter,
  SenderPolicyRepository,
} from '../application/notifications/ports.js';
import { QueryNotifications } from '../application/notifications/query-notifications.js';
import { RetryNotification } from '../application/notifications/retry-notification.js';
import type { Metrics } from '../application/ports/metrics.js';
import type { ApiDependencies } from './app.js';

export interface ApiCompositionInput {
  notifications: NotificationRepository;
  manualRetries: ManualRetryRepository;
  apiKeys: ApiKeyRepository;
  providerConfig: ProviderConfigRepository;
  providerEvents: Pick<ProviderEventRepository, 'record'>;
  senderPolicy: SenderPolicyRepository;
  registry: CapabilityChecker & WebhookAdapterSource;
  secrets: WebhookSecretSource;
  /** null disables rate limiting (e.g. tests). */
  rateLimiter: RateLimiter | null;
  backlog: BacklogGuard;
  logger: Logger;
  clock?: Clock;
  /** Per-tenant limit on submissions and manual retries (`INGRESS_RATE_*`). */
  ingressLimit: IngressRateLimit;
  /** Per provider-instance limit on verified webhook calls (`WEBHOOK_RATE_*`). */
  webhookLimit: IngressRateLimit;
  /** Per provider-instance limit on webhook calls failing verification; off when omitted. */
  webhookInvalidLimit?: IngressRateLimit;
  /** Failed authentications per client IP (API keys and webhooks); off when omitted. */
  authFailureLimit?: IngressRateLimit;
  /** Per-tenant limit on read routes (`READ_RATE_*`); off when omitted. */
  readLimit?: IngressRateLimit;
  metrics?: Metrics;
}

/** Wires the API use cases from repositories and infrastructure adapters. */
export function createApiDependencies(input: ApiCompositionInput): ApiDependencies {
  const clock = input.clock ?? (() => new Date());
  const ingress = new IngressLimiter(
    input.rateLimiter,
    input.ingressLimit,
    input.logger,
    'ingress:',
  );
  const webhookLimiter = new IngressLimiter(
    input.rateLimiter,
    input.webhookLimit,
    input.logger,
    'webhook:',
  );
  const optional = <T>(
    settings: IngressRateLimit | undefined,
    build: (s: IngressRateLimit) => T,
  ) => (settings === undefined || input.rateLimiter === null ? null : build(settings));
  const webhookInvalid = optional(
    input.webhookInvalidLimit,
    (s) => new FailureBudget(input.rateLimiter, s, input.logger, 'webhook-invalid:'),
  );
  const authFailures = optional(
    input.authFailureLimit,
    (s) => new FailureBudget(input.rateLimiter, s, input.logger, 'authfail:'),
  );
  const reads = optional(
    input.readLimit,
    (s) => new IngressLimiter(input.rateLimiter, s, input.logger, 'read:'),
  );
  const metrics = input.metrics === undefined ? {} : { metrics: input.metrics };
  return {
    apiKeys: input.apiKeys,
    authGuards: { failures: authFailures, reads },
    clock,
    ...metrics,
    createNotification: new CreateNotification({
      notifications: input.notifications,
      providerConfig: input.providerConfig,
      capabilities: input.registry,
      senderPolicy: input.senderPolicy,
      ingress,
      backlog: input.backlog,
      clock,
    }),
    queryNotifications: new QueryNotifications(input.notifications),
    retryNotification: new RetryNotification({
      notifications: input.notifications,
      providerConfig: input.providerConfig,
      manualRetries: input.manualRetries,
      ingress,
      clock,
    }),
    ingestWebhook: new IngestWebhook({
      providerConfig: input.providerConfig,
      providerEvents: input.providerEvents,
      adapters: input.registry,
      secrets: input.secrets,
      limiter: webhookLimiter,
      invalidLimiter: webhookInvalid,
      clientFailures: authFailures,
      clock,
      logger: input.logger,
      ...metrics,
    }),
  };
}
