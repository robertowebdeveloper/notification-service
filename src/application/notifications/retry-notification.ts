import type { ProviderConfigRepository } from '../ports/lookup-repositories.js';
import type { ManualRetryRepository, NotificationRepository } from '../ports/repositories.js';
import { ApplicationError } from './errors.js';
import type { IngressLimiter } from './ingress-guards.js';
import type { Clock } from './ports.js';

/** Budget used when the routing policy of the notification no longer exists. */
export const DEFAULT_MANUAL_RETRY_ATTEMPTS = 3;

export interface RetryNotificationDeps {
  notifications: Pick<NotificationRepository, 'findById'>;
  providerConfig: Pick<ProviderConfigRepository, 'resolveRoutingPolicy'>;
  manualRetries: ManualRetryRepository;
  ingress: IngressLimiter;
  clock: Clock;
}

export interface RetryNotificationCommand {
  tenantId: number;
  apiKeyId: number;
  notificationId: number;
  idempotencyKey: string;
}

export interface RetryNotificationOutcome {
  notificationId: number;
  generation: number;
  replayed: boolean;
}

/**
 * Manual retry of a `failed` delivery whose attempts were all certain rejections. The new
 * attempt budget is the `maxAttempts` of the current routing policy for the same route.
 */
export class RetryNotification {
  constructor(private readonly deps: RetryNotificationDeps) {}

  async execute(command: RetryNotificationCommand): Promise<RetryNotificationOutcome> {
    await this.deps.ingress.check(command.tenantId);
    const detail = await this.deps.notifications.findById(command.tenantId, command.notificationId);
    if (detail === null) throw new ApplicationError('not_found', 'Notification not found');

    const policy = await this.deps.providerConfig.resolveRoutingPolicy(
      command.tenantId,
      detail.routingKey,
      detail.channel,
      detail.platform,
    );
    const result = await this.deps.manualRetries.retryFailed({
      tenantId: command.tenantId,
      notificationId: command.notificationId,
      retryIdempotencyKey: command.idempotencyKey,
      actorApiKeyId: command.apiKeyId,
      maxAttempts: policy?.maxAttempts ?? DEFAULT_MANUAL_RETRY_ATTEMPTS,
      now: this.deps.clock(),
    });

    switch (result.kind) {
      case 'scheduled':
      case 'replayed':
        return {
          notificationId: command.notificationId,
          generation: result.generation,
          replayed: result.kind === 'replayed',
        };
      case 'not_found':
        throw new ApplicationError('not_found', 'Notification not found');
      case 'not_retryable':
        throw new ApplicationError(
          'conflict',
          'Only failed notifications whose attempts were all definitely rejected can be retried',
          { submissionStatus: result.submissionStatus },
        );
    }
  }
}
