import { describe, expect, it } from 'vitest';
import { IngressLimiter } from '../../../../src/application/notifications/ingress-guards.js';
import { RetryNotification } from '../../../../src/application/notifications/retry-notification.js';
import type { RoutingPolicyRecord } from '../../../../src/application/ports/lookup-repositories.js';
import type {
  ManualRetryInput,
  NotificationDetail,
} from '../../../../src/application/ports/repositories.js';

const silent = { warn: () => undefined };

function detail(platform: string | null): NotificationDetail {
  const now = new Date();
  return {
    id: 42,
    channel: 'push',
    platform,
    routingKey: 'alerts',
    submissionStatus: 'failed',
    receiptStatus: 'unavailable',
    createdAt: now,
    updatedAt: now,
    attempts: [],
    lastError: null,
  };
}

describe('RetryNotification', () => {
  it('resolves the budget with the stored platform of the notification', async () => {
    const stored = detail('fcm');
    const lookups: (string | null)[] = [];
    const retries: ManualRetryInput[] = [];
    const useCase = new RetryNotification({
      notifications: { findById: () => Promise.resolve(stored) },
      providerConfig: {
        resolveRoutingPolicy: (_tenant, _key, _channel, platform) => {
          lookups.push(platform);
          return Promise.resolve(
            platform === 'fcm' ? ({ maxAttempts: 7 } as RoutingPolicyRecord) : null,
          );
        },
      },
      manualRetries: {
        retryFailed: (input) => {
          retries.push(input);
          return Promise.resolve({ kind: 'scheduled', generation: 2 });
        },
      },
      ingress: new IngressLimiter(null, { limit: 1, windowMs: 1_000 }, silent),
      clock: () => new Date(),
    });

    const outcome = await useCase.execute({
      tenantId: 3,
      apiKeyId: 5,
      notificationId: stored.id,
      idempotencyKey: 'retry-1',
    });
    expect(outcome).toEqual({ notificationId: stored.id, generation: 2, replayed: false });
    expect(lookups).toEqual(['fcm']);
    expect(retries[0]?.maxAttempts).toBe(7);
  });
});
