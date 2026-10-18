import { Type, type Static } from 'typebox';
import type { PayloadByChannel } from '../../../contracts/channels.js';
import { formatMailbox, parseMailbox } from '../../../contracts/email-address.js';
import type {
  ConfigValidationResult,
  NormalizedEventType,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderStatusResult,
  ResolvedProviderInstance,
  SendContext,
  SendResult,
  WebhookParseResult,
} from '../../../contracts/provider-port.js';
import { validateWithSchema } from '../config-validation.js';
import { deploymentPolicyIssues, type ProviderDeploymentPolicy } from '../deployment-policy.js';
import {
  DEFAULT_SEND_TIMEOUT_MS,
  PROVIDER_ERROR_CODES as CODES,
  UNKNOWN_REASONS,
  abortedBeforeSubmission,
  missingSecret,
  readSecret,
  rejected,
  unknownOutcome,
} from '../send-results.js';
import { classifyFetchFailure, classifyResendStatus } from './resend-classification.js';
import {
  verifyAndParseResendWebhook,
  WebhookSecretError,
  type WebhookHeaders,
} from './resend-webhook.js';

export const RESEND_PROVIDER_TYPE = 'resend';
export const RESEND_DEFAULT_BASE_URL = 'https://api.resend.com';
/** Documented Resend idempotency-key retention: 24 hours. */
export const RESEND_IDEMPOTENCY_WINDOW_SECONDS = 24 * 60 * 60;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
const MAX_RESPONSE_BYTES = 64 * 1024;

export const ResendConfigSchema = Type.Object(
  {
    /** Operator-configured API base URL (overridable for test servers). */
    baseUrl: Type.String({ minLength: 1, maxLength: 2048, default: RESEND_DEFAULT_BASE_URL }),
    /** `local` allows plain-HTTP base URLs (test doubles); `remote` requires HTTPS. */
    profile: Type.Enum(['remote', 'local'], { default: 'remote' }),
    requestTimeoutMs: Type.Integer({
      minimum: 100,
      maximum: 300_000,
      default: DEFAULT_SEND_TIMEOUT_MS,
    }),
  },
  { additionalProperties: false },
);
export type ResendConfig = Static<typeof ResendConfigSchema>;

export const RESEND_SECRET_KEYS = { apiKey: 'apiKey', webhookSecret: 'webhookSecret' } as const;

export const RESEND_CAPABILITIES: ProviderCapabilities = Object.freeze({
  channels: Object.freeze(['email'] as const),
  platforms: Object.freeze([]),
  formats: Object.freeze(['text', 'html']),
  idempotency: Object.freeze({
    supported: true as const,
    windowSeconds: RESEND_IDEMPOTENCY_WINDOW_SECONDS,
  }),
  receipts: true,
  statusQuery: true,
});

const LAST_EVENT_RECEIPTS: Readonly<Record<string, NormalizedEventType | undefined>> = {
  queued: undefined,
  scheduled: undefined,
  sent: 'accepted',
  delivered: 'delivered',
  delivery_delayed: 'delivery_delayed',
  bounced: 'bounced_hard',
  complained: 'complained',
  failed: 'failed',
  opened: 'opened',
  clicked: 'clicked',
};

/** Error thrown by `getStatus`; code is sanitized and provider-agnostic. */
export class ProviderRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderRequestError';
  }
}

interface TransportEntry {
  revision: number;
  baseUrl: string;
  inFlight: Set<AbortController>;
}

interface HttpOutcome {
  response?: Response;
  body?: unknown;
  bodyReadable: boolean;
  failure?: unknown;
  interruption?: 'timeout' | 'aborted' | undefined;
}

async function readJson(response: Response): Promise<{ ok: boolean; value: unknown }> {
  try {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_RESPONSE_BYTES) return { ok: false, value: undefined };
    if (buffer.length === 0) return { ok: true, value: undefined };
    return { ok: true, value: JSON.parse(buffer.toString('utf8')) as unknown };
  } catch {
    return { ok: false, value: undefined };
  }
}

function field(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = (value as Record<string, unknown>)[key];
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}

const API_KEY_PATTERN = /^[\x21-\x7e]{1,512}$/;

/**
 * Resend adapter over HTTP (global fetch, no SDK). Every send carries
 * `Idempotency-Key: context.idempotencyKey`, so replays inside the 24h window are safe.
 */
export class ResendEmailAdapter implements ProviderAdapter<'email', ResendConfig> {
  readonly providerType = RESEND_PROVIDER_TYPE;
  readonly capabilities = RESEND_CAPABILITIES;
  readonly requiredSecrets: readonly string[] = Object.freeze([
    RESEND_SECRET_KEYS.apiKey,
    RESEND_SECRET_KEYS.webhookSecret,
  ]);

  private readonly transports = new Map<number, TransportEntry>();

  /** `policy`: deployment restrictions (APP_ENV, PROVIDER_ALLOWED_HOSTS); none by default. */
  constructor(private readonly policy: ProviderDeploymentPolicy = {}) {}

  validateConfig(config: unknown): ConfigValidationResult<ResendConfig> {
    const result = validateWithSchema(ResendConfigSchema, config);
    if (!result.ok) return result;
    let url: URL;
    try {
      url = new URL(result.config.baseUrl);
    } catch {
      return { ok: false, errors: ['/baseUrl must be an absolute URL'] };
    }
    const errors: string[] = deploymentPolicyIssues(this.policy, {
      profile: result.config.profile,
      host: url.hostname,
      hostField: '/baseUrl host',
    });
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && result.config.profile === 'local')
    ) {
      errors.push('/baseUrl must use https (http is allowed only with profile "local")');
    }
    if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
      errors.push('/baseUrl must not contain credentials, query or fragment');
    }
    return errors.length > 0 ? { ok: false, errors } : result;
  }

  async send(
    payload: PayloadByChannel['email'],
    context: SendContext<ResendConfig>,
  ): Promise<SendResult> {
    if (context.signal.aborted) return abortedBeforeSubmission();
    const apiKey = readSecret(context.instance.secrets, RESEND_SECRET_KEYS.apiKey);
    if (apiKey === undefined) return missingSecret(RESEND_SECRET_KEYS.apiKey);
    if (!API_KEY_PATTERN.test(apiKey)) {
      return rejected('configuration', CODES.configurationInvalid, 'Provider API key is malformed');
    }
    const key = context.idempotencyKey;
    if (key === '' || key.length > MAX_IDEMPOTENCY_KEY_LENGTH || !/^[\x20-\x7e]+$/.test(key)) {
      return rejected('configuration', CODES.configurationInvalid, 'Idempotency key is not usable');
    }

    const { content, recipient } = payload;
    if (content.text === undefined && content.html === undefined) {
      return rejected('permanent', CODES.invalidRequest, 'Email content has no text or html body');
    }
    // Rebuilt from the strictly parsed mailbox: the provider sees the authorized address only.
    const sender = parseMailbox(content.from);
    if (sender === null) {
      return rejected('permanent', CODES.invalidRequest, 'Email sender is not a single mailbox');
    }
    const body = JSON.stringify({
      from: formatMailbox(sender),
      to: [recipient.email],
      subject: content.subject,
      ...(content.text !== undefined ? { text: content.text } : {}),
      ...(content.html !== undefined ? { html: content.html } : {}),
      ...(content.replyTo !== undefined ? { reply_to: content.replyTo } : {}),
    });

    const transport = this.transportFor(context.instance);
    const outcome = await this.request(transport, '/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'idempotency-key': key,
      },
      body,
      signal: context.signal,
      timeoutMs: context.instance.config.requestTimeoutMs,
    });

    const { response } = outcome;
    if (response === undefined) return classifyFetchFailure(outcome.failure, outcome.interruption);
    if (response.status >= 200 && response.status < 300) {
      const id = outcome.bodyReadable ? field(outcome.body, 'id') : undefined;
      if (id === undefined) return unknownOutcome(UNKNOWN_REASONS.unparsableResponse);
      return { outcome: 'accepted', externalReference: id };
    }
    return classifyResendStatus(response.status, response.headers, field(outcome.body, 'name'));
  }

  async getStatus(
    externalReference: string,
    instance: ResolvedProviderInstance<ResendConfig>,
    signal: AbortSignal,
  ): Promise<ProviderStatusResult> {
    const apiKey = readSecret(instance.secrets, RESEND_SECRET_KEYS.apiKey);
    if (apiKey === undefined || !API_KEY_PATTERN.test(apiKey)) {
      throw new ProviderRequestError(CODES.missingSecret, 'Provider API key is not available');
    }
    const outcome = await this.request(
      this.transportFor(instance),
      `/emails/${encodeURIComponent(externalReference)}`,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${apiKey}` },
        signal,
        timeoutMs: instance.config.requestTimeoutMs,
      },
    );
    const { response } = outcome;
    if (response === undefined) {
      throw new ProviderRequestError(
        outcome.interruption === 'timeout' ? CODES.timeout : CODES.connectionFailed,
        'Provider status query failed',
      );
    }
    if (response.status === 404) return { found: false };
    if (response.status < 200 || response.status >= 300) {
      throw new ProviderRequestError(
        response.status === 429 ? CODES.rateLimited : 'status_query_failed',
        `Provider status query failed (HTTP ${response.status})`,
      );
    }
    if (!outcome.bodyReadable || field(outcome.body, 'id') === undefined) {
      throw new ProviderRequestError('unparsable_response', 'Provider status response is invalid');
    }
    const lastEvent = field(outcome.body, 'last_event');
    const receipt =
      lastEvent === undefined
        ? undefined
        : lastEvent in LAST_EVENT_RECEIPTS
          ? LAST_EVENT_RECEIPTS[lastEvent]
          : 'other';
    return receipt === undefined
      ? { found: true, accepted: true }
      : { found: true, accepted: true, receipt };
  }

  verifyAndParseWebhook(
    rawBody: Buffer,
    headers: WebhookHeaders,
    instance: ResolvedProviderInstance<ResendConfig>,
  ): Promise<WebhookParseResult> {
    const secret = readSecret(instance.secrets, RESEND_SECRET_KEYS.webhookSecret);
    if (secret === undefined) return Promise.reject(new WebhookSecretError());
    try {
      return Promise.resolve(verifyAndParseResendWebhook(rawBody, headers, secret));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new WebhookSecretError());
    }
  }

  close(): Promise<void> {
    for (const entry of this.transports.values()) {
      for (const controller of entry.inFlight) controller.abort();
      entry.inFlight.clear();
    }
    this.transports.clear();
    return Promise.resolve();
  }

  private transportFor(instance: ResolvedProviderInstance<ResendConfig>): TransportEntry {
    const cached = this.transports.get(instance.id);
    if (cached?.revision === instance.revision) return cached;
    const entry: TransportEntry = {
      revision: instance.revision,
      baseUrl: instance.config.baseUrl.replace(/\/+$/, ''),
      inFlight: cached?.inFlight ?? new Set(),
    };
    this.transports.set(instance.id, entry);
    return entry;
  }

  private async request(
    transport: TransportEntry,
    path: string,
    init: {
      method: 'GET' | 'POST';
      headers: Record<string, string>;
      body?: string;
      signal: AbortSignal;
      timeoutMs: number;
    },
  ): Promise<HttpOutcome> {
    const controller = new AbortController();
    let interruption: 'timeout' | 'aborted' | undefined;
    const onAbort = (): void => {
      interruption ??= 'aborted';
      controller.abort();
    };
    const timer = setTimeout(() => {
      interruption ??= 'timeout';
      controller.abort();
    }, init.timeoutMs);
    init.signal.addEventListener('abort', onAbort, { once: true });
    transport.inFlight.add(controller);
    try {
      let response: Response;
      try {
        response = await fetch(`${transport.baseUrl}${path}`, {
          method: init.method,
          headers: {
            accept: 'application/json',
            'user-agent': 'notification-service',
            ...init.headers,
          },
          ...(init.body !== undefined ? { body: init.body } : {}),
          signal: controller.signal,
          redirect: 'manual',
        });
      } catch (failure) {
        return {
          failure,
          bodyReadable: false,
          interruption: interruption ?? (controller.signal.aborted ? 'aborted' : undefined),
        };
      }
      const parsed = await readJson(response);
      return { response, body: parsed.value, bodyReadable: parsed.ok };
    } finally {
      clearTimeout(timer);
      init.signal.removeEventListener('abort', onAbort);
      transport.inFlight.delete(controller);
    }
  }
}
