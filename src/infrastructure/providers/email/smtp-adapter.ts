import { Readable } from 'node:stream';
import MailComposer from 'nodemailer/lib/mail-composer';
import SMTPConnection, {
  type SMTPConnectionOptions,
  type SMTPError,
} from 'nodemailer/lib/smtp-connection';
import { Type, type Static } from 'typebox';
import type { PayloadByChannel } from '../../../contracts/channels.js';
import { mailboxDomain, parseMailbox } from '../../../contracts/email-address.js';
import type {
  ConfigValidationResult,
  ProviderAdapter,
  ProviderCapabilities,
  ResolvedProviderInstance,
  SendContext,
  SendResult,
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
import { classifySmtpError, type SmtpPhase } from './smtp-classification.js';

export const SMTP_PROVIDER_TYPE = 'smtp';

const HOSTNAME_PATTERN = '^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$';
const timeoutMs = (defaultValue: number) =>
  Type.Integer({ minimum: 100, maximum: 300_000, default: defaultValue });

export const SmtpConfigSchema = Type.Object(
  {
    host: Type.String({ minLength: 1, maxLength: 253 }),
    port: Type.Integer({ minimum: 1, maximum: 65535 }),
    /** Implicit TLS from the first byte (usually port 465). */
    secure: Type.Boolean({ default: false }),
    /** Mandatory STARTTLS upgrade when `secure` is false. */
    requireTLS: Type.Boolean({ default: true }),
    /** TLS is mandatory unless the instance is explicitly marked with the local profile. */
    tlsRequired: Type.Boolean({ default: true }),
    profile: Type.Enum(['remote', 'local'], { default: 'remote' }),
    /** When true, `username` and `password` are resolved through the instance secret_ref. */
    auth: Type.Boolean({ default: false }),
    clientName: Type.Optional(Type.String({ pattern: HOSTNAME_PATTERN })),
    /** Domain used in the stable Message-ID; defaults to the sender domain. */
    messageIdDomain: Type.Optional(Type.String({ pattern: HOSTNAME_PATTERN })),
    connectionTimeoutMs: timeoutMs(10_000),
    greetingTimeoutMs: timeoutMs(10_000),
    socketTimeoutMs: timeoutMs(DEFAULT_SEND_TIMEOUT_MS),
    /** Upper bound for a whole send (connect, auth, envelope, data). */
    sendTimeoutMs: timeoutMs(DEFAULT_SEND_TIMEOUT_MS),
  },
  { additionalProperties: false },
);
export type SmtpConfig = Static<typeof SmtpConfigSchema>;

export const SMTP_SECRET_KEYS = { username: 'username', password: 'password' } as const;

export const SMTP_CAPABILITIES: ProviderCapabilities = Object.freeze({
  channels: Object.freeze(['email'] as const),
  platforms: Object.freeze([]),
  formats: Object.freeze(['text', 'html']),
  idempotency: Object.freeze({ supported: false as const }),
  receipts: false,
  statusQuery: false,
});

/** Stable Message-ID for every attempt of the same delivery (correlation only, not dedup). */
export function smtpMessageId(deliveryId: string, domain: string): string {
  const local = deliveryId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 128);
  return `<delivery.${local}@${domain}>`;
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

interface TransportEntry {
  revision: number;
  options: SMTPConnectionOptions;
  active: Set<SMTPConnection>;
}

/**
 * Generic SMTP adapter. Opens one connection per send (no pooling, no transport-level
 * retries): PostgreSQL owns the retry budget. Success means "accepted by the SMTP server";
 * receipts are not available.
 */
export class SmtpEmailAdapter implements ProviderAdapter<'email', SmtpConfig> {
  readonly providerType = SMTP_PROVIDER_TYPE;
  readonly capabilities = SMTP_CAPABILITIES;
  /** Required only when `config.auth` is true, see `requiredSecretsFor`. */
  readonly requiredSecrets: readonly string[] = Object.freeze([
    SMTP_SECRET_KEYS.username,
    SMTP_SECRET_KEYS.password,
  ]);

  private readonly transports = new Map<string, TransportEntry>();

  /** `policy`: deployment restrictions (APP_ENV, PROVIDER_ALLOWED_HOSTS); none by default. */
  constructor(private readonly policy: ProviderDeploymentPolicy = {}) {}

  validateConfig(config: unknown): ConfigValidationResult<SmtpConfig> {
    const result = validateWithSchema(SmtpConfigSchema, config);
    if (!result.ok) return result;
    const value = result.config;
    const errors: string[] = deploymentPolicyIssues(this.policy, {
      profile: value.profile,
      host: value.host,
      hostField: '/host',
    });
    if (value.tlsRequired && !value.secure && !value.requireTLS) {
      errors.push('/requireTLS must be true (or secure must be true) when tlsRequired is true');
    }
    if (!value.tlsRequired && value.profile !== 'local') {
      errors.push('/tlsRequired may be false only for instances with profile "local"');
    }
    return errors.length > 0 ? { ok: false, errors } : result;
  }

  /** Secrets actually needed by a given configuration. */
  requiredSecretsFor(config: SmtpConfig): readonly string[] {
    return config.auth ? this.requiredSecrets : [];
  }

  async send(
    payload: PayloadByChannel['email'],
    context: SendContext<SmtpConfig>,
  ): Promise<SendResult> {
    if (context.signal.aborted) return abortedBeforeSubmission();
    const config = context.instance.config;

    let auth: { user: string; pass: string } | undefined;
    if (config.auth) {
      const user = readSecret(context.instance.secrets, SMTP_SECRET_KEYS.username);
      if (user === undefined) return missingSecret(SMTP_SECRET_KEYS.username);
      const pass = readSecret(context.instance.secrets, SMTP_SECRET_KEYS.password);
      if (pass === undefined) return missingSecret(SMTP_SECRET_KEYS.password);
      auth = { user, pass };
    }

    const { content, recipient } = payload;
    if (content.text === undefined && content.html === undefined) {
      return rejected('permanent', CODES.invalidRequest, 'Email content has no text or html body');
    }
    // The same strict parser as the sender allow-list: the header From and the envelope sender
    // are the single address that was authorized, never re-parsed from the raw string.
    const sender = parseMailbox(content.from);
    if (sender === null) {
      return rejected('permanent', CODES.invalidRequest, 'Email sender is not a single mailbox');
    }
    const domain = config.messageIdDomain ?? mailboxDomain(sender);
    const messageId = smtpMessageId(context.deliveryId, domain);

    let raw: Buffer;
    let envelope: { from: string; to: string[] };
    try {
      const node = new MailComposer({
        from: sender.name === undefined ? sender.address : sender,
        to: recipient.email,
        subject: content.subject,
        messageId,
        disableFileAccess: true,
        disableUrlAccess: true,
        ...(content.text !== undefined ? { text: content.text } : {}),
        ...(content.html !== undefined ? { html: content.html } : {}),
        ...(content.replyTo !== undefined ? { replyTo: content.replyTo } : {}),
      }).compile();
      const parsed = node.getEnvelope();
      if (parsed.from === false || parsed.to.length !== 1) {
        return rejected('permanent', CODES.invalidRequest, 'Email sender or recipient is invalid');
      }
      envelope = { from: sender.address, to: parsed.to };
      raw = await node.build();
    } catch {
      return rejected('permanent', CODES.invalidRequest, 'Email message could not be composed');
    }
    // Composition is asynchronous: the caller may have aborted in the meantime.
    if (isAborted(context.signal)) return abortedBeforeSubmission();

    const transport = this.transportFor(context.instance);
    return this.submit(transport, envelope, raw, messageId, auth, context.signal, config);
  }

  private submit(
    transport: TransportEntry,
    envelope: { from: string; to: string[] },
    raw: Buffer,
    messageId: string,
    auth: { user: string; pass: string } | undefined,
    signal: AbortSignal,
    config: SmtpConfig,
  ): Promise<SendResult> {
    return new Promise<SendResult>((resolve) => {
      const connection = new SMTPConnection(transport.options);
      transport.active.add(connection);
      let phase: SmtpPhase = 'connect';
      let settled = false;

      const finish = (result: SendResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        transport.active.delete(connection);
        resolve(result);
      };
      const interrupt = (afterSubmission: SendResult, before: SendResult): void => {
        // Settle first: closing emits 'end', which must not override the interruption reason.
        finish(phase === 'data' ? afterSubmission : before);
        connection.close();
      };
      const onAbort = (): void => {
        interrupt(
          unknownOutcome(UNKNOWN_REASONS.abortedAfterSubmission),
          abortedBeforeSubmission(),
        );
      };
      const timer = setTimeout(() => {
        interrupt(
          unknownOutcome(UNKNOWN_REASONS.timeoutAfterSubmission),
          rejected('retryable', CODES.timeout, 'SMTP send timed out before submission'),
        );
      }, config.sendTimeoutMs);
      signal.addEventListener('abort', onAbort, { once: true });

      const fail = (error: SMTPError): void => {
        finish(classifySmtpError(error, phase));
      };
      connection.on('error', fail);
      connection.on('end', () => {
        if (phase === 'data') finish(unknownOutcome(UNKNOWN_REASONS.connectionLostAfterSubmission));
        else finish(rejected('retryable', CODES.connectionFailed, 'SMTP connection closed early'));
      });

      const transmit = (): void => {
        phase = 'envelope';
        let streamed = false;
        const body = new Readable({
          read() {
            if (streamed) return;
            streamed = true;
            phase = 'data';
            this.push(raw);
            this.push(null);
          },
        });
        connection.send(envelope, body, (error) => {
          if (error) {
            fail(error);
            return;
          }
          finish({ outcome: 'accepted', externalReference: messageId });
          connection.quit();
        });
      };

      connection.connect((error) => {
        if (error) {
          fail(error);
          return;
        }
        if (settled) return;
        if (auth === undefined) {
          transmit();
          return;
        }
        phase = 'auth';
        connection.login({ credentials: auth }, (loginError) => {
          if (loginError) {
            fail(loginError);
            return;
          }
          if (!settled) transmit();
        });
      });
    });
  }

  private transportFor(instance: ResolvedProviderInstance<SmtpConfig>): TransportEntry {
    const cached = this.transports.get(instance.id);
    if (cached?.revision === instance.revision) return cached;
    // Connections of a previous revision finish their current send and are not reused.
    const config = instance.config;
    const entry: TransportEntry = {
      revision: instance.revision,
      active: new Set(),
      options: {
        host: config.host,
        port: config.port,
        secure: config.secure,
        requireTLS: !config.secure && config.requireTLS,
        ignoreTLS: false,
        opportunisticTLS: false,
        connectionTimeout: config.connectionTimeoutMs,
        greetingTimeout: config.greetingTimeoutMs,
        socketTimeout: config.socketTimeoutMs,
        dnsTimeout: config.connectionTimeoutMs,
        logger: false,
        debug: false,
        transactionLog: false,
        tls: { minVersion: 'TLSv1.2' },
        ...(config.clientName !== undefined ? { name: config.clientName } : {}),
      },
    };
    this.transports.set(instance.id, entry);
    return entry;
  }

  close(): Promise<void> {
    for (const entry of this.transports.values()) {
      for (const connection of entry.active) connection.close();
      entry.active.clear();
    }
    this.transports.clear();
    return Promise.resolve();
  }
}
