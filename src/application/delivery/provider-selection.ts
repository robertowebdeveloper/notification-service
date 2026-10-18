import type { Channel, ChannelPayload } from '../../contracts/channels.js';
import type {
  ProviderAdapter,
  ResolvedProviderInstance,
  SecretValues,
} from '../../contracts/provider-port.js';
import { capabilitiesCover, payloadRequirements } from '../../domain/provider-eligibility.js';
import type {
  ProviderConfigRepository,
  ProviderInstanceRecord,
} from '../ports/lookup-repositories.js';
import type { RoutingSnapshot } from '../ports/repositories.js';
import type {
  DeliveryLogger,
  ProviderCatalog,
  ProviderCircuitBreaker,
  SecretSource,
} from './ports.js';

/** Snapshots written before `fallbackEnabled` existed default to the policy default (true). */
export function fallbackEnabledOf(routing: RoutingSnapshot): boolean {
  return (routing.fallbackEnabled as boolean | undefined) !== false;
}

export interface SelectedProvider {
  record: ProviderInstanceRecord;
  adapter: ProviderAdapter<Channel>;
  instance: ResolvedProviderInstance;
  /** Token of the single recovery probe of a half-open breaker held by this call, if any. */
  probeToken: string | null;
}

/** Why a candidate was skipped: temporary reasons defer the delivery, permanent ones do not. */
export type SkipReason =
  | { kind: 'temporary'; code: 'kill_switch' | 'circuit_open'; retryAfterMs?: number }
  | {
      kind: 'permanent';
      code:
        | 'instance_not_found'
        | 'channel_mismatch'
        | 'unknown_provider_type'
        | 'capabilities_mismatch'
        | 'invalid_configuration'
        | 'secrets_unavailable';
    };

export type PermanentSkipCode = Extract<SkipReason, { kind: 'permanent' }>['code'];

export type CandidateResult =
  { kind: 'selected'; provider: SelectedProvider } | { kind: 'skipped'; reason: SkipReason };

export class BackendUnavailableError extends Error {
  constructor(
    readonly backend: 'circuit_breaker' | 'rate_limiter',
    cause: unknown,
  ) {
    super(`${backend} unavailable`, { cause });
    this.name = 'BackendUnavailableError';
  }
}

export interface ProviderResolverDeps {
  providerConfig: ProviderConfigRepository;
  catalog: ProviderCatalog;
  secrets: SecretSource;
  breaker: ProviderCircuitBreaker;
  logger: DeliveryLogger;
  configurationQuarantineMs: number;
}

/**
 * Turns a provider instance id into a usable, resolved provider: kill switch, channel/platform,
 * capabilities, configuration validity, circuit breaker and secrets. Never sends anything.
 */
export class ProviderResolver {
  constructor(private readonly deps: ProviderResolverDeps) {}

  /** Resolves config and secrets of an instance (also used by reconciliation status queries). */
  async resolveInstance(
    record: ProviderInstanceRecord,
    adapter: ProviderAdapter<Channel>,
  ): Promise<
    { ok: true; instance: ResolvedProviderInstance } | { ok: false; code: PermanentSkipCode }
  > {
    const validated = adapter.validateConfig(record.config);
    if (!validated.ok) {
      this.deps.logger.error(
        {
          alarm: 'provider_configuration_invalid',
          providerInstanceId: record.id,
          errors: validated.errors,
        },
        'provider instance configuration is invalid',
      );
      return { ok: false, code: 'invalid_configuration' };
    }
    let keys: readonly string[];
    try {
      keys = this.deps.catalog.requiredSecretsFor(record.providerType, validated.config);
    } catch {
      return { ok: false, code: 'unknown_provider_type' };
    }
    let secrets: SecretValues = new Map();
    if (keys.length > 0) {
      if (record.secretRef === null) {
        this.deps.logger.error(
          { alarm: 'provider_secret_missing', providerInstanceId: record.id },
          'provider instance requires secrets but has no secret_ref',
        );
        return { ok: false, code: 'secrets_unavailable' };
      }
      try {
        secrets = await this.deps.secrets.resolve(record.secretRef, keys);
      } catch (error) {
        this.deps.logger.error(
          {
            alarm: 'provider_secret_unresolvable',
            providerInstanceId: record.id,
            code: (error as { code?: unknown }).code,
          },
          'provider instance secrets cannot be resolved',
        );
        return { ok: false, code: 'secrets_unavailable' };
      }
    }
    return {
      ok: true,
      instance: {
        id: record.id,
        tenantId: record.tenantId,
        providerType: record.providerType,
        revision: record.revision,
        config: validated.config,
        secrets,
      },
    };
  }

  async evaluate(
    tenantId: number,
    instanceId: number,
    payload: ChannelPayload,
    routing: RoutingSnapshot,
    options: { requireIdempotency?: boolean } = {},
  ): Promise<CandidateResult> {
    const record = await this.deps.providerConfig.findProviderInstance(tenantId, instanceId);
    if (record === null) return skip('permanent', 'instance_not_found');
    if (record.channel !== payload.channel || record.platform !== routing.platform) {
      return skip('permanent', 'channel_mismatch');
    }
    if (!record.enabled) return skip('temporary', 'kill_switch');
    const adapter = this.deps.catalog.forChannel(record.providerType, payload.channel);
    if (adapter === undefined) return skip('permanent', 'unknown_provider_type');
    if (!capabilitiesCover(adapter.capabilities, payloadRequirements(payload), options)) {
      return skip('permanent', 'capabilities_mismatch');
    }

    let permit;
    try {
      permit = await this.deps.breaker.acquire(record.id);
    } catch (error) {
      throw new BackendUnavailableError('circuit_breaker', error);
    }
    if (!permit.allowed) {
      return {
        kind: 'skipped',
        reason: { kind: 'temporary', code: 'circuit_open', retryAfterMs: permit.retryAfterMs },
      };
    }

    const probeToken = permit.probe ? permit.probeToken : null;
    const resolved = await this.resolveInstance(record, adapter);
    if (!resolved.ok) {
      // Operational quarantine: other deliveries skip the instance until an operator fixes it.
      await this.deps.breaker
        .forceOpen(record.id, this.deps.configurationQuarantineMs)
        .catch(() => undefined);
      return skip('permanent', resolved.code);
    }
    return {
      kind: 'selected',
      provider: { record, adapter, instance: resolved.instance, probeToken },
    };
  }
}

function skip(kind: 'temporary', code: 'kill_switch' | 'circuit_open'): CandidateResult;
function skip(kind: 'permanent', code: PermanentSkipCode): CandidateResult;
function skip(kind: 'temporary' | 'permanent', code: string): CandidateResult {
  return { kind: 'skipped', reason: { kind, code } as SkipReason };
}
