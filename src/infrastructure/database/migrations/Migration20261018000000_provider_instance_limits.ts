import { Migration } from '@mikro-orm/migrations';

/**
 * Per provider-instance send limits set by operators through `config:apply`:
 * `{ "sendRateLimit"?: { "burst", "perSecond" }, "circuitBreaker"?: { "failureThreshold"?,
 * "failureWindowMs"?, "openMs"? } }`. An empty object means the worker env defaults apply.
 * Kept out of `config` so adapter configuration schemas stay strict and limits do not bump
 * anything the adapters validate.
 */
export class Migration20261018000000ProviderInstanceLimits extends Migration {
  override name = 'Migration20261018000000_provider_instance_limits';

  override up(): void {
    this.addSql(
      `alter table provider_instances add column limits jsonb not null default '{}'::jsonb;`,
    );
  }

  override down(): void {
    this.addSql(`alter table provider_instances drop column if exists limits;`);
  }
}
