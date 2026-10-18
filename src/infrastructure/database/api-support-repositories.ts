import type { SenderPolicyRepository } from '../../application/notifications/ports.js';
import { forkEm, isId, str, toId, type Orm, type Row } from './sql-support.js';

/**
 * Lookups needed by the public API and config:apply that are not part of the shared ports.
 *
 * Allowed senders are stored in `tenants.quotas.allowedSenders` (operator-managed JSON written
 * by config:apply) until a dedicated column/table is introduced by a coordinated migration.
 */
export class PgSenderPolicyRepository implements SenderPolicyRepository {
  constructor(private readonly orm: Orm) {}

  async allowedSenders(tenantId: number): Promise<readonly string[]> {
    if (!isId(tenantId)) return [];
    const found = await forkEm(this.orm).execute<Row[]>(
      `select quotas->'allowedSenders' as senders from tenants where id = ?`,
      [tenantId],
    );
    const senders = found[0]?.senders;
    return Array.isArray(senders) ? senders.filter((s): s is string => typeof s === 'string') : [];
  }
}

export interface ExistingApiKey {
  id: number;
  keyPrefix: string;
  keyHash: string;
}

/** Lets config:apply keep an existing key (no rotation) when re-applying the same file. */
export class PgApiKeyAdminLookup {
  constructor(private readonly orm: Orm) {}

  async findByName(tenantId: number, name: string): Promise<ExistingApiKey | null> {
    if (!isId(tenantId)) return null;
    const found = await forkEm(this.orm).execute<Row[]>(
      `select id, key_prefix, key_hash from api_keys where tenant_id = ? and name = ?`,
      [tenantId, name],
    );
    const row = found[0];
    return row
      ? { id: toId(row.id), keyPrefix: str(row.key_prefix), keyHash: str(row.key_hash) }
      : null;
  }
}
