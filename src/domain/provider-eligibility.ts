import type { ChannelPayload } from '../contracts/channels.js';
import type { ProviderCapabilities, ProviderErrorKind } from '../contracts/provider-port.js';

/** Capabilities a provider must offer to carry this payload (expressed as capabilities only). */
export interface PayloadRequirements {
  channel: ChannelPayload['channel'];
  platform: string | null;
  formats: string[];
}

export function payloadRequirements(payload: ChannelPayload): PayloadRequirements {
  switch (payload.channel) {
    case 'email': {
      const formats: string[] = [];
      if (payload.content.text !== undefined) formats.push('text');
      if (payload.content.html !== undefined) formats.push('html');
      return { channel: 'email', platform: null, formats };
    }
    case 'sms':
      return { channel: 'sms', platform: null, formats: ['text'] };
    case 'push':
      return { channel: 'push', platform: payload.recipient.platform, formats: ['text'] };
    case 'messaging':
      return {
        channel: 'messaging',
        platform: payload.recipient.platform,
        formats: [payload.content.type],
      };
  }
}

export function capabilitiesCover(
  capabilities: ProviderCapabilities,
  requirements: PayloadRequirements,
  options: { requireIdempotency?: boolean } = {},
): boolean {
  if (!capabilities.channels.includes(requirements.channel)) return false;
  if (requirements.platform !== null && !capabilities.platforms.includes(requirements.platform)) {
    return false;
  }
  if (!requirements.formats.every((format) => capabilities.formats.includes(format))) return false;
  if (options.requireIdempotency === true && !capabilities.idempotency.supported) return false;
  return true;
}

/** Minimal view of a past attempt needed by the fallback rules. */
export interface AttemptFacts {
  providerInstanceId: number;
  outcome: 'started' | 'accepted' | 'rejected' | 'unknown';
  errorKind: ProviderErrorKind | null;
}

/**
 * Instances excluded for the rest of this delivery: those that definitely rejected it for a
 * configuration problem. Retryable rejections do not exclude an instance (the shared circuit
 * breaker decides when an unhealthy instance must be skipped).
 */
export function excludedInstances(history: readonly AttemptFacts[]): Set<number> {
  return new Set(
    history
      .filter((attempt) => attempt.outcome === 'rejected' && attempt.errorKind === 'configuration')
      .map((attempt) => attempt.providerInstanceId),
  );
}

/**
 * Ordered candidates for the next attempt: snapshot order, excluded instances removed. When
 * fallback is disabled by the policy only the first instance of the snapshot is ever used.
 */
export function candidateOrder(
  snapshotInstanceIds: readonly number[],
  excluded: ReadonlySet<number>,
  fallbackEnabled: boolean,
): number[] {
  const ordered = fallbackEnabled ? snapshotInstanceIds : snapshotInstanceIds.slice(0, 1);
  return ordered.filter((id) => !excluded.has(id));
}

export interface FallbackInput {
  error: { kind: ProviderErrorKind; definitelyNotAccepted: boolean };
  currentInstanceId: number;
  snapshotInstanceIds: readonly number[];
  history: readonly AttemptFacts[];
  fallbackEnabled: boolean;
  attemptsUsed: number;
  maxAttempts: number;
}

/**
 * Immediate fallback to another provider is allowed only after a certain rejection caused by
 * the provider instance configuration, within the global budget of the delivery (not
 * multiplied per provider), and only when another not-excluded instance exists.
 */
export function isFallbackEligible(input: FallbackInput): boolean {
  if (input.error.kind !== 'configuration' || !input.error.definitelyNotAccepted) return false;
  if (!input.fallbackEnabled) return false;
  if (input.attemptsUsed >= input.maxAttempts) return false;
  const excluded = excludedInstances(input.history);
  excluded.add(input.currentInstanceId);
  return candidateOrder(input.snapshotInstanceIds, excluded, true).length > 0;
}
