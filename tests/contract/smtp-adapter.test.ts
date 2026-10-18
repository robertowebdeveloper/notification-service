import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResolvedProviderInstance } from '../../src/contracts/provider-port.js';
import {
  SmtpEmailAdapter,
  smtpMessageId,
  type SmtpConfig,
} from '../../src/infrastructure/providers/email/smtp-adapter.js';
import {
  emailPayload,
  emailPayloadFrom,
  runEmailAdapterConformance,
  SENDER_BYPASS_PAYLOADS,
  sendContext,
} from './support/conformance.js';
import {
  closedPort,
  startFakeSmtpServer,
  type FakeSmtpServer,
} from './support/fake-smtp-server.js';

function localConfig(port: number, overrides: Partial<SmtpConfig> = {}): SmtpConfig {
  const result = new SmtpEmailAdapter().validateConfig({
    host: '127.0.0.1',
    port,
    profile: 'local',
    tlsRequired: false,
    requireTLS: false,
    ...overrides,
  });
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.config;
}

let instanceCounter = 0;
/** Each call is a distinct instance: transports are cached per instance id and revision. */
function instance(
  config: SmtpConfig,
  secrets: Record<string, string> = {},
  revision = 1,
): ResolvedProviderInstance<SmtpConfig> {
  instanceCounter += 1;
  return {
    id: `smtp-instance-${instanceCounter}`,
    tenantId: 'tenant-1',
    providerType: 'smtp',
    revision,
    config,
    secrets: new Map(Object.entries(secrets)),
  };
}

let conformanceServer: FakeSmtpServer | undefined;
runEmailAdapterConformance<SmtpConfig>({
  name: 'SMTP',
  start: async () => {
    conformanceServer = await startFakeSmtpServer();
  },
  stop: async () => {
    await conformanceServer?.close();
  },
  adapter: () => new SmtpEmailAdapter(),
  instance: (timeoutMs) => {
    if (!conformanceServer) throw new Error('server not started');
    return instance(localConfig(conformanceServer.port, { sendTimeoutMs: timeoutMs }));
  },
  submissions: () => conformanceServer?.connections ?? 0,
});

describe('SMTP adapter', () => {
  let server: FakeSmtpServer;
  const adapter = new SmtpEmailAdapter();

  beforeAll(async () => {
    server = await startFakeSmtpServer();
  });
  afterAll(async () => {
    await adapter.close();
    await server.close();
  });

  const send = (behaviour: string, overrides: Partial<SmtpConfig> = {}) =>
    adapter.send(
      emailPayload(behaviour),
      sendContext(instance(localConfig(server.port, overrides))),
    );

  describe('capabilities and configuration', () => {
    it('declares no idempotency, receipts or status query', () => {
      expect(adapter.capabilities).toMatchObject({
        idempotency: { supported: false },
        receipts: false,
        statusQuery: false,
      });
      expect('getStatus' in adapter).toBe(false);
      expect('verifyAndParseWebhook' in adapter).toBe(false);
    });

    it('requires TLS unless the instance uses the local profile', () => {
      const plain = adapter.validateConfig({
        host: 'smtp.example.test',
        port: 25,
        tlsRequired: false,
      });
      expect(plain.ok).toBe(false);
      const noTls = adapter.validateConfig({
        host: 'smtp.example.test',
        port: 25,
        requireTLS: false,
      });
      expect(noTls.ok).toBe(false);
    });

    it('applies secure defaults to a minimal remote configuration', () => {
      const result = adapter.validateConfig({ host: 'smtp.example.test', port: 587 });
      expect(result).toMatchObject({
        ok: true,
        config: { requireTLS: true, tlsRequired: true, profile: 'remote', sendTimeoutMs: 15_000 },
      });
    });

    it('needs username and password only when authentication is enabled', () => {
      expect(adapter.requiredSecretsFor(localConfig(25))).toEqual([]);
      expect(adapter.requiredSecretsFor(localConfig(25, { auth: true }))).toEqual([
        'username',
        'password',
      ]);
    });
  });

  describe('successful submission', () => {
    it('reports accepted (not delivered) and sends a stable Message-ID per delivery', async () => {
      const context = sendContext(instance(localConfig(server.port)));
      const first = await adapter.send(emailPayload('accept'), context);
      const second = await adapter.send(emailPayload('accept'), {
        ...context,
        attemptId: 'another-attempt',
      });
      const expectedId = smtpMessageId(context.deliveryId, 'example.test');
      expect(first).toEqual({ outcome: 'accepted', externalReference: expectedId });
      expect(second).toEqual(first);
      const headers = server.messages
        .slice(-2)
        .map((message) => /^Message-ID: (.+)$/im.exec(message.raw)?.[1]?.trim());
      expect(headers).toEqual([expectedId, expectedId]);
    });

    it('uses the configured Message-ID domain when provided', async () => {
      const context = sendContext(
        instance(localConfig(server.port, { messageIdDomain: 'mail.example.test' })),
      );
      const result = await adapter.send(emailPayload('accept'), context);
      expect(result).toMatchObject({
        externalReference: smtpMessageId(context.deliveryId, 'mail.example.test'),
      });
    });
  });

  describe('explicit SMTP replies', () => {
    it('treats a 4xx reply at RCPT as a certain retryable rejection', async () => {
      await expect(send('rcpt-451')).resolves.toEqual({
        outcome: 'rejected',
        error: expect.objectContaining({
          kind: 'retryable',
          code: 'recipient_rejected',
          definitelyNotAccepted: true,
        }) as unknown,
      });
    });

    it('treats a 5xx reply at RCPT as a certain permanent rejection', async () => {
      await expect(send('rcpt-550')).resolves.toMatchObject({
        outcome: 'rejected',
        error: { kind: 'permanent', code: 'recipient_rejected', definitelyNotAccepted: true },
      });
    });

    it('treats a 4xx reply after DATA as a certain retryable rejection', async () => {
      await expect(send('data-451')).resolves.toMatchObject({
        outcome: 'rejected',
        error: { kind: 'retryable', code: 'message_rejected', definitelyNotAccepted: true },
      });
    });

    it('treats a 5xx reply after DATA as a certain permanent rejection', async () => {
      await expect(send('data-554')).resolves.toMatchObject({
        outcome: 'rejected',
        error: { kind: 'permanent', code: 'message_rejected', definitelyNotAccepted: true },
      });
    });
  });

  describe('ambiguous and pre-submission failures', () => {
    it('returns unknown when the server stays silent after the message data', async () => {
      await expect(send('hang', { sendTimeoutMs: 300 })).resolves.toEqual({
        outcome: 'unknown',
        reason: 'timeout_after_submission',
      });
    });

    it('returns unknown when the socket times out after the message data', async () => {
      await expect(send('hang', { sendTimeoutMs: 5_000, socketTimeoutMs: 200 })).resolves.toEqual({
        outcome: 'unknown',
        reason: 'timeout_after_submission',
      });
    });

    it('treats connection refused as a certain retryable rejection', async () => {
      const port = await closedPort();
      await expect(
        adapter.send(emailPayload('accept'), sendContext(instance(localConfig(port)))),
      ).resolves.toMatchObject({
        outcome: 'rejected',
        error: { kind: 'retryable', code: 'connection_failed', definitelyNotAccepted: true },
      });
    });

    it('reports a missing authentication secret as a configuration error', async () => {
      await expect(send('accept', { auth: true })).resolves.toMatchObject({
        outcome: 'rejected',
        error: { kind: 'configuration', code: 'missing_secret', definitelyNotAccepted: true },
      });
    });
  });

  describe('authentication', () => {
    let authServer: FakeSmtpServer;
    beforeAll(async () => {
      authServer = await startFakeSmtpServer({
        credentials: { username: 'smtp-user', password: 'smtp-pass' },
      });
    });
    afterAll(async () => {
      await authServer.close();
    });

    it('authenticates with resolved secrets', async () => {
      const result = await adapter.send(
        emailPayload('accept'),
        sendContext(
          instance(localConfig(authServer.port, { auth: true }), {
            username: 'smtp-user',
            password: 'smtp-pass',
          }),
        ),
      );
      expect(result.outcome).toBe('accepted');
    });

    it('classifies rejected credentials as a configuration error without leaking them', async () => {
      const result = await adapter.send(
        emailPayload('accept'),
        sendContext(
          instance(localConfig(authServer.port, { auth: true }), {
            username: 'smtp-user',
            password: 'wrong-secret',
          }),
        ),
      );
      expect(result).toMatchObject({
        outcome: 'rejected',
        error: {
          kind: 'configuration',
          code: 'authentication_failed',
          definitelyNotAccepted: true,
        },
      });
      expect(JSON.stringify(result)).not.toContain('wrong-secret');
    });
  });
});

describe('SMTP adapter sender and deployment policy', () => {
  let server: FakeSmtpServer;
  const adapter = new SmtpEmailAdapter();

  beforeAll(async () => {
    server = await startFakeSmtpServer();
  });
  afterAll(async () => {
    await adapter.close();
    await server.close();
  });

  it('uses the single parsed sender address for both the envelope and the From header', async () => {
    const result = await adapter.send(
      emailPayloadFrom('"Shop (EU)" <Sender@Example.test>'),
      sendContext(instance(localConfig(server.port))),
    );
    expect(result.outcome).toBe('accepted');
    const message = server.messages.at(-1);
    expect(message?.from).toBe('Sender@Example.test');
    expect(message?.to).toEqual(['accept@example.test']);
    // Nodemailer normalizes the domain case in the header; the mailbox is the same.
    expect(message?.raw).toMatch(/^From: "Shop \(EU\)" <Sender@example\.test>\r?$/im);
    expect(message?.raw).not.toMatch(/attacker/);
  });

  it.each(SENDER_BYPASS_PAYLOADS)(
    'refuses the multi-address sender %j without connecting',
    async (from) => {
      const before = server.connections;
      const result = await adapter.send(
        emailPayloadFrom(from),
        sendContext(instance(localConfig(server.port))),
      );
      expect(result).toMatchObject({
        outcome: 'rejected',
        error: { kind: 'permanent', code: 'invalid_request', definitelyNotAccepted: true },
      });
      expect(server.connections).toBe(before);
    },
  );

  it('refuses profile "local" outside local/test and hosts outside PROVIDER_ALLOWED_HOSTS', () => {
    const local = {
      host: 'mailpit',
      port: 1025,
      profile: 'local',
      tlsRequired: false,
      requireTLS: false,
    };
    for (const environment of ['local', 'test']) {
      expect(new SmtpEmailAdapter({ environment }).validateConfig(local).ok).toBe(true);
    }
    for (const environment of ['stage', 'production', 'unexpected']) {
      const result = new SmtpEmailAdapter({ environment }).validateConfig(local);
      expect(result).toEqual({
        ok: false,
        errors: [`/profile "local" is not allowed in ${environment}`],
      });
    }
    const restricted = new SmtpEmailAdapter({
      environment: 'production',
      allowedHosts: ['smtp.example.com', '.mail.example.net'],
    });
    for (const host of ['smtp.example.com', 'SMTP.example.com.', 'eu.mail.example.net']) {
      expect(restricted.validateConfig({ host, port: 587 }).ok).toBe(true);
    }
    for (const host of ['evil.example.com', 'mail.example.net', 'smtp.example.com.evil.test']) {
      expect(restricted.validateConfig({ host, port: 587 })).toEqual({
        ok: false,
        errors: ['/host is not allowed by PROVIDER_ALLOWED_HOSTS'],
      });
    }
  });
});
