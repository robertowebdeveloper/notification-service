import type { Channel } from '../../contracts/channels.js';
import type {
  ConfigValidationResult,
  ProviderAdapter,
  ProviderCapabilities,
} from '../../contracts/provider-port.js';
import { deploymentPolicyFromEnv, type ProviderDeploymentPolicy } from './deployment-policy.js';
import { ResendEmailAdapter } from './email/resend-adapter.js';
import { SmtpEmailAdapter } from './email/smtp-adapter.js';

/** Any adapter regardless of channel or config type. */
export type AnyProviderAdapter = {
  [C in Channel]: ProviderAdapter<C>;
}[Channel];

/** Requirements a routing candidate must satisfy; expressed as capabilities, never names. */
export interface CapabilityRequirements {
  channel: Channel;
  platform?: string;
  format?: string;
  idempotency?: boolean;
  /** Minimum idempotency window needed for safe replays. */
  minIdempotencyWindowSeconds?: number;
  receipts?: boolean;
  statusQuery?: boolean;
}

interface ConfigDependentSecrets {
  requiredSecretsFor(config: unknown): readonly string[];
}

function hasConfigDependentSecrets(adapter: object): adapter is ConfigDependentSecrets & object {
  return typeof (adapter as Partial<ConfigDependentSecrets>).requiredSecretsFor === 'function';
}

export class UnknownProviderTypeError extends Error {
  constructor(readonly providerType: string) {
    super(`Unknown provider type "${providerType}"`);
    this.name = 'UnknownProviderTypeError';
  }
}

export function satisfiesCapabilities(
  capabilities: ProviderCapabilities,
  requirements: CapabilityRequirements,
): boolean {
  if (!capabilities.channels.includes(requirements.channel)) return false;
  if (
    requirements.platform !== undefined &&
    !capabilities.platforms.includes(requirements.platform)
  ) {
    return false;
  }
  if (requirements.format !== undefined && !capabilities.formats.includes(requirements.format)) {
    return false;
  }
  if (requirements.idempotency === true || requirements.minIdempotencyWindowSeconds !== undefined) {
    if (!capabilities.idempotency.supported) return false;
    if (
      requirements.minIdempotencyWindowSeconds !== undefined &&
      capabilities.idempotency.windowSeconds < requirements.minIdempotencyWindowSeconds
    ) {
      return false;
    }
  }
  if (requirements.receipts === true && !capabilities.receipts) return false;
  if (requirements.statusQuery === true && !capabilities.statusQuery) return false;
  return true;
}

/** Maps providerType to its adapter. Shared code reasons on capabilities only. */
export class ProviderRegistry {
  private readonly adapters = new Map<string, AnyProviderAdapter>();

  constructor(adapters: Iterable<AnyProviderAdapter> = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: AnyProviderAdapter): void {
    if (this.adapters.has(adapter.providerType)) {
      throw new Error(`Provider type "${adapter.providerType}" is already registered`);
    }
    this.adapters.set(adapter.providerType, adapter);
  }

  has(providerType: string): boolean {
    return this.adapters.has(providerType);
  }

  get(providerType: string): AnyProviderAdapter {
    const adapter = this.adapters.get(providerType);
    if (adapter === undefined) throw new UnknownProviderTypeError(providerType);
    return adapter;
  }

  /** Typed lookup for a channel; undefined when the type is unknown or serves another channel. */
  forChannel<C extends Channel>(providerType: string, channel: C): ProviderAdapter<C> | undefined {
    const adapter = this.adapters.get(providerType);
    if (adapter === undefined || !adapter.capabilities.channels.includes(channel)) return undefined;
    return adapter as ProviderAdapter<C>;
  }

  providerTypes(): string[] {
    return [...this.adapters.keys()];
  }

  capabilities(providerType: string): ProviderCapabilities {
    return this.get(providerType).capabilities;
  }

  supports(providerType: string, requirements: CapabilityRequirements): boolean {
    const adapter = this.adapters.get(providerType);
    return adapter !== undefined && satisfiesCapabilities(adapter.capabilities, requirements);
  }

  validateConfig(providerType: string, config: unknown): ConfigValidationResult<unknown> {
    const adapter = this.adapters.get(providerType);
    if (adapter === undefined) {
      return { ok: false, errors: [`unknown provider type "${providerType}"`] };
    }
    return adapter.validateConfig(config);
  }

  /** Secret keys needed by a validated config (some adapters need secrets only for some configs). */
  requiredSecretsFor(providerType: string, validatedConfig: unknown): readonly string[] {
    const adapter = this.get(providerType);
    return hasConfigDependentSecrets(adapter)
      ? adapter.requiredSecretsFor(validatedConfig)
      : adapter.requiredSecrets;
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled(
      [...this.adapters.values()].map(async (adapter) => {
        await adapter.close?.();
      }),
    );
  }
}

/**
 * Registry with the email adapters of the first release. `policy` (APP_ENV,
 * PROVIDER_ALLOWED_HOSTS) is enforced by every `validateConfig`, i.e. at config:apply and on each
 * runtime resolution of a stored instance; when omitted it is read from the process environment.
 */
export function createEmailProviderRegistry(
  policy: ProviderDeploymentPolicy = deploymentPolicyFromEnv(),
): ProviderRegistry {
  return new ProviderRegistry([new SmtpEmailAdapter(policy), new ResendEmailAdapter(policy)]);
}
