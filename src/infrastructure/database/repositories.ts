import type { MikroORM } from '@mikro-orm/postgresql';
import { PgAdminConfigRepository } from './admin-config-repository.js';
import { PgDeliveryControlRepository } from './delivery-control-repository.js';
import { PgDeliveryRepository } from './delivery-repository.js';
import {
  PgApiKeyRepository,
  PgAuditRepository,
  PgDeliveryReceiptRepository,
  PgProviderConfigRepository,
  PgProviderEventRepository,
  PgSuppressionRepository,
} from './lookup-repositories.js';
import { PgNotificationRepository } from './notification-repository.js';
import { PgOutboxRepository } from './outbox-repository.js';

/** Builds every PostgreSQL repository on top of one initialized ORM (each call forks its own EM). */
export function createRepositories(orm: MikroORM) {
  return {
    notifications: new PgNotificationRepository(orm),
    outbox: new PgOutboxRepository(orm),
    deliveries: new PgDeliveryRepository(orm),
    deliveryControl: new PgDeliveryControlRepository(orm),
    apiKeys: new PgApiKeyRepository(orm),
    providerConfig: new PgProviderConfigRepository(orm),
    providerEvents: new PgProviderEventRepository(orm),
    receipts: new PgDeliveryReceiptRepository(orm),
    suppressions: new PgSuppressionRepository(orm),
    audit: new PgAuditRepository(orm),
    adminConfig: new PgAdminConfigRepository(orm),
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
