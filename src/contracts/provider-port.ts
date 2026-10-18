import type { Channel, PayloadByChannel } from './channels.js';

export interface ProviderCapabilities {
  channels: readonly Channel[];
  /** Platforms reachable (push/messaging); empty for channels without platforms. */
  platforms: readonly string[];
  /** Content formats, e.g. 'text', 'html', 'template'. */
  formats: readonly string[];
  idempotency: { supported: false } | { supported: true; windowSeconds: number };
  receipts: boolean;
  statusQuery: boolean;
}

export type SecretValues = ReadonlyMap<string, string>;

export interface ResolvedProviderInstance<TConfig = unknown> {
  id: number;
  tenantId: number;
  providerType: string;
  revision: number;
  config: TConfig;
  secrets: SecretValues;
}

export interface SendContext<TConfig = unknown> {
  deliveryId: number;
  /**
   * Creation time of the notification. Ids are sequential, so they repeat after a database reset
   * and across environments: together with `deliveryId` this identifies the delivery globally.
   */
  createdAt: Date;
  attemptId: number;
  instance: ResolvedProviderInstance<TConfig>;
  /** Stable key derived from the persisted operation; reused on safe replays. */
  idempotencyKey: string;
  signal: AbortSignal;
}

export type ProviderErrorKind = 'retryable' | 'permanent' | 'configuration';

/**
 * Only for certain rejections: adapters must return `unknown` for anything ambiguous,
 * so `definitelyNotAccepted` is true for every error inside a `rejected` result.
 */
export interface ProviderError {
  kind: ProviderErrorKind;
  /** Sanitized, provider-agnostic code (no PII). */
  code: string;
  message: string;
  retryAfterMs?: number;
  /** True only when the provider certainly did not accept the message. */
  definitelyNotAccepted: boolean;
}

export type SendResult =
  | { outcome: 'accepted'; externalReference?: string }
  | { outcome: 'rejected'; error: ProviderError }
  | { outcome: 'unknown'; reason: string; externalReference?: string };

export type ProviderStatusResult =
  { found: true; accepted: boolean; receipt?: NormalizedEventType } | { found: false };

export const NORMALIZED_EVENT_TYPES = [
  'accepted',
  'delivered',
  'delivery_delayed',
  'bounced_hard',
  'bounced_soft',
  'complained',
  'failed',
  'opened',
  'clicked',
  'other',
] as const;
export type NormalizedEventType = (typeof NORMALIZED_EVENT_TYPES)[number];

export interface NormalizedProviderEvent {
  externalEventId: string;
  externalMessageId: string | null;
  type: NormalizedEventType;
  occurredAt: Date;
  /** Minimized payload: no message bodies or secrets. */
  payload: Record<string, unknown>;
}

export type WebhookParseResult =
  | { ok: true; events: NormalizedProviderEvent[] }
  | { ok: false; reason: 'invalid_signature' | 'stale_timestamp' | 'malformed' };

export type ConfigValidationResult<TConfig> =
  { ok: true; config: TConfig } | { ok: false; errors: string[] };

export interface ProviderAdapter<C extends Channel, TConfig = unknown> {
  readonly providerType: string;
  readonly capabilities: ProviderCapabilities;
  /** Every secret key the adapter may need (superset). */
  readonly requiredSecrets: readonly string[];
  /** Secret keys actually needed by a validated config; defaults to `requiredSecrets`. */
  requiredSecretsFor?(config: TConfig): readonly string[];
  validateConfig(config: unknown): ConfigValidationResult<TConfig>;
  send(payload: PayloadByChannel[C], context: SendContext<TConfig>): Promise<SendResult>;
  getStatus?(
    externalReference: string,
    instance: ResolvedProviderInstance<TConfig>,
    signal: AbortSignal,
  ): Promise<ProviderStatusResult>;
  verifyAndParseWebhook?(
    rawBody: Buffer,
    headers: Readonly<Record<string, string | string[] | undefined>>,
    instance: ResolvedProviderInstance<TConfig>,
  ): Promise<WebhookParseResult>;
  /** Release pooled transports. */
  close?(): Promise<void>;
}
