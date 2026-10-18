import type {
  ConfigValidationResult,
  ResolvedProviderInstance,
  SecretValues,
  WebhookParseResult,
} from '../../contracts/provider-port.js';
import type {
  ProviderConfigRepository,
  ProviderEventRepository,
} from '../ports/lookup-repositories.js';
import { noopMetrics, type Metrics, type WebhookInvalidReason } from '../ports/metrics.js';
import { ApplicationError } from './errors.js';
import { rateLimited, type FailureBudget, type IngressLimiter } from './ingress-guards.js';
import type { Clock } from './ports.js';

/** Structural subset of the provider registry used by webhook ingestion. */
export interface WebhookAdapterSource {
  has(providerType: string): boolean;
  validateConfig(providerType: string, config: unknown): ConfigValidationResult<unknown>;
  requiredSecretsFor(providerType: string, validatedConfig: unknown): readonly string[];
  get(providerType: string): {
    verifyAndParseWebhook?(
      rawBody: Buffer,
      headers: Readonly<Record<string, string | string[] | undefined>>,
      instance: ResolvedProviderInstance,
    ): Promise<WebhookParseResult>;
  };
}

export interface WebhookSecretSource {
  resolve(secretRef: string, keys: readonly string[]): Promise<SecretValues>;
}

export interface IngestWebhookDeps {
  providerConfig: Pick<ProviderConfigRepository, 'findProviderInstanceForWebhook'>;
  providerEvents: Pick<ProviderEventRepository, 'record'>;
  adapters: WebhookAdapterSource;
  secrets: WebhookSecretSource;
  /**
   * Per provider instance limit on VERIFIED calls only (fail open when Valkey is unavailable):
   * forged or unsigned traffic is never charged to it, so it cannot starve the real provider.
   */
  limiter: IngressLimiter | null;
  /** Per provider instance budget of calls failing verification (`WEBHOOK_INVALID_RATE_*`). */
  invalidLimiter?: FailureBudget | null;
  /** Per client IP budget of failed authentications (`AUTH_FAILURE_RATE_*`), shared with the API. */
  clientFailures?: FailureBudget | null;
  clock: Clock;
  logger: { warn(obj: object, msg: string): void; error(obj: object, msg: string): void };
  metrics?: Metrics;
}

export interface IngestWebhookCommand {
  providerType: string;
  instanceId: number;
  rawBody: Buffer;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  /** Client address as seen by the HTTP layer (honours HTTP_TRUST_PROXY). */
  clientIp?: string;
}

export interface IngestWebhookOutcome {
  received: number;
  duplicates: number;
}

const INVALID = 'Webhook could not be authenticated';

/**
 * Verifies and durably records provider events. Events are only persisted here; applying them to
 * deliveries (reducer, suppressions) belongs to the delivery pipeline. The tenant always comes
 * from the configured instance, never from the payload.
 */
export class IngestWebhook {
  constructor(private readonly deps: IngestWebhookDeps) {}

  async execute(command: IngestWebhookCommand): Promise<IngestWebhookOutcome> {
    const { providerType, instanceId, clientIp } = command;
    // A client that keeps failing is shed before any database lookup or verification.
    if (clientIp !== undefined) await this.deps.clientFailures?.assertNotExhausted(clientIp);
    if (!this.deps.adapters.has(providerType)) {
      await this.clientFailed(clientIp);
      throw new ApplicationError('not_found', 'Not found');
    }
    const adapter = this.deps.adapters.get(providerType);
    if (adapter.verifyAndParseWebhook === undefined) {
      await this.clientFailed(clientIp);
      throw new ApplicationError('not_found', 'Not found');
    }
    const instance = await this.deps.providerConfig.findProviderInstanceForWebhook(
      providerType,
      instanceId,
    );
    if (instance === null) {
      await this.clientFailed(clientIp);
      this.invalid(providerType, 'unknown_instance');
      throw new ApplicationError('not_found', 'Not found');
    }

    const validated = this.deps.adapters.validateConfig(providerType, instance.config);
    if (!validated.ok) {
      this.deps.logger.error({ instanceId }, 'stored provider config is invalid');
      this.invalid(providerType, 'unavailable');
      throw new ApplicationError('dependency_unavailable', 'Webhook temporarily unavailable');
    }
    let secrets: SecretValues = new Map();
    const keys = this.deps.adapters.requiredSecretsFor(providerType, validated.config);
    if (keys.length > 0) {
      try {
        if (instance.secretRef === null) throw new Error('instance has no secret_ref');
        secrets = await this.deps.secrets.resolve(instance.secretRef, keys);
      } catch (err) {
        this.deps.logger.error({ err, instanceId }, 'webhook secrets cannot be resolved');
        this.invalid(providerType, 'unavailable');
        throw new ApplicationError('dependency_unavailable', 'Webhook temporarily unavailable');
      }
    }

    let parsed: WebhookParseResult;
    try {
      parsed = await adapter.verifyAndParseWebhook(command.rawBody, command.headers, {
        id: instance.id,
        tenantId: instance.tenantId,
        providerType: instance.providerType,
        revision: instance.revision,
        config: validated.config,
        secrets,
      });
    } catch (err) {
      this.deps.logger.error({ err, instanceId }, 'webhook verification failed unexpectedly');
      this.invalid(providerType, 'unavailable');
      throw new ApplicationError('dependency_unavailable', 'Webhook temporarily unavailable');
    }
    if (!parsed.ok) {
      this.invalid(providerType, parsed.reason);
      await this.clientFailed(clientIp);
      const budget = await this.deps.invalidLimiter?.recordFailure(instance.id);
      if (budget !== undefined && !budget.allowed) {
        // Flood of invalid calls for this instance: answer 429 and stop logging each of them.
        throw rateLimited(budget.retryAfterMs);
      }
      this.deps.logger.warn({ instanceId, reason: parsed.reason }, 'invalid webhook rejected');
      throw new ApplicationError('unauthorized', INVALID);
    }
    // Only verified calls are charged to the instance budget.
    await this.deps.limiter?.check(instance.id);

    const receivedAt = this.deps.clock();
    let duplicates = 0;
    for (const event of parsed.events) {
      const recorded = await this.deps.providerEvents.record({
        tenantId: instance.tenantId,
        providerInstanceId: instance.id,
        externalEventId: event.externalEventId,
        externalMessageId: event.externalMessageId,
        type: event.type,
        occurredAt: event.occurredAt,
        receivedAt,
        payload: event.payload,
      });
      if (recorded.kind === 'duplicate') duplicates += 1;
    }
    (this.deps.metrics ?? noopMetrics).webhookReceived(providerType);
    return { received: parsed.events.length, duplicates };
  }

  private async clientFailed(clientIp: string | undefined): Promise<void> {
    if (clientIp !== undefined) await this.deps.clientFailures?.recordFailure(clientIp);
  }

  /** Only called once `providerType` is known to the registry (bounded label). */
  private invalid(providerType: string, reason: WebhookInvalidReason): void {
    (this.deps.metrics ?? noopMetrics).webhookInvalid(providerType, reason);
  }
}
