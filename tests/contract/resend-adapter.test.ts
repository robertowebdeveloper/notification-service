import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResolvedProviderInstance } from '../../src/contracts/provider-port.js';
import {
  ResendEmailAdapter,
  type ResendConfig,
} from '../../src/infrastructure/providers/email/resend-adapter.js';
import { closedPort } from './support/fake-smtp-server.js';
import {
  emailPayload,
  emailPayloadFrom,
  runEmailAdapterConformance,
  SENDER_BYPASS_PAYLOADS,
  sendContext,
} from './support/conformance.js';
import { startFakeResendServer, type FakeResendServer } from './support/fake-resend-server.js';

const API_KEY = 're_test_key';
const WEBHOOK_SECRET = `whsec_${Buffer.from('contract-test-signing-key').toString('base64')}`;

function localConfig(baseUrl: string, overrides: Partial<ResendConfig> = {}): ResendConfig {
  const result = new ResendEmailAdapter().validateConfig({
    baseUrl,
    profile: 'local',
    ...overrides,
  });
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.config;
}

let instanceCounter = 0;
function instance(
  config: ResendConfig,
  secrets: Record<string, string> = { apiKey: API_KEY, webhookSecret: WEBHOOK_SECRET },
): ResolvedProviderInstance<ResendConfig> {
  instanceCounter += 1;
  return {
    id: instanceCounter,
    tenantId: 1,
    providerType: 'resend',
    revision: 1,
    config,
    secrets: new Map(Object.entries(secrets)),
  };
}

let conformanceServer: FakeResendServer | undefined;
runEmailAdapterConformance<ResendConfig>({
  name: 'Resend',
  start: async () => {
    conformanceServer = await startFakeResendServer();
  },
  stop: async () => {
    await conformanceServer?.close();
  },
  adapter: () => new ResendEmailAdapter(),
  instance: (timeoutMs) => {
    if (!conformanceServer) throw new Error('server not started');
    return instance(localConfig(conformanceServer.baseUrl, { requestTimeoutMs: timeoutMs }));
  },
  submissions: () => conformanceServer?.requests.length ?? 0,
});

describe('Resend adapter', () => {
  let server: FakeResendServer;
  const adapter = new ResendEmailAdapter();

  beforeAll(async () => {
    server = await startFakeResendServer();
  });
  afterAll(async () => {
    await adapter.close();
    await server.close();
  });

  const send = (behaviour: string) =>
    adapter.send(emailPayload(behaviour), sendContext(instance(localConfig(server.baseUrl))));

  describe('capabilities and configuration', () => {
    it('declares a 24 hour idempotency window, receipts and status query', () => {
      expect(adapter.capabilities).toMatchObject({
        idempotency: { supported: true, windowSeconds: 86_400 },
        receipts: true,
        statusQuery: true,
      });
      expect(adapter.requiredSecrets).toEqual(['apiKey', 'webhookSecret']);
    });

    it('defaults to the public API over HTTPS', () => {
      expect(adapter.validateConfig({})).toEqual({
        ok: true,
        config: { baseUrl: 'https://api.resend.com', profile: 'remote', requestTimeoutMs: 15_000 },
      });
    });

    it('allows plain HTTP base URLs only for the local profile', () => {
      expect(adapter.validateConfig({ baseUrl: 'http://127.0.0.1:9' }).ok).toBe(false);
      expect(adapter.validateConfig({ baseUrl: 'http://127.0.0.1:9', profile: 'local' }).ok).toBe(
        true,
      );
      expect(adapter.validateConfig({ baseUrl: 'https://u:p@api.example.test' }).ok).toBe(false);
      expect(adapter.validateConfig({ baseUrl: 'not a url' }).ok).toBe(false);
    });
  });

  describe('request shape', () => {
    it('sends the API key and the idempotency key, reusing it on replays', async () => {
      const context = sendContext(instance(localConfig(server.baseUrl)));
      const first = await adapter.send(emailPayload('accept'), context);
      const replay = await adapter.send(emailPayload('accept'), {
        ...context,
        attemptId: context.attemptId + 1,
      });

      expect(first).toEqual({
        outcome: 'accepted',
        externalReference: expect.stringMatching(/^re_/) as unknown,
      });
      expect(replay).toEqual(first);
      const [a, b] = server.requests.slice(-2);
      expect(a?.headers['idempotency-key']).toBe(context.idempotencyKey);
      expect(b?.headers['idempotency-key']).toBe(context.idempotencyKey);
      expect(a?.headers.authorization).toBe(`Bearer ${API_KEY}`);
      expect(a?.body).toEqual({
        from: 'Notifications <sender@example.test>',
        to: ['accept@example.test'],
        subject: 'Contract test',
        text: 'Plain body',
        html: '<p>HTML body</p>',
      });
    });

    it('reports a missing API key as a configuration error without calling the provider', async () => {
      const before = server.requests.length;
      const result = await adapter.send(
        emailPayload('accept'),
        sendContext(instance(localConfig(server.baseUrl), {})),
      );
      expect(result).toMatchObject({
        outcome: 'rejected',
        error: { kind: 'configuration', code: 'missing_secret', definitelyNotAccepted: true },
      });
      expect(server.requests.length).toBe(before);
    });
  });

  describe('response classification', () => {
    it.each([
      ['http-400', 'permanent', 'invalid_request'],
      ['http-422', 'permanent', 'invalid_request'],
      ['http-401', 'configuration', 'authentication_failed'],
      ['http-403', 'configuration', 'configuration_invalid'],
    ] as const)('maps %s to a certain %s rejection', async (behaviour, kind, code) => {
      await expect(send(behaviour)).resolves.toMatchObject({
        outcome: 'rejected',
        error: { kind, code, definitelyNotAccepted: true },
      });
    });

    it('maps 429 to a retryable rejection honouring Retry-After', async () => {
      await expect(send('http-429')).resolves.toEqual({
        outcome: 'rejected',
        error: {
          kind: 'retryable',
          code: 'rate_limited',
          message: 'Provider rate limit exceeded',
          retryAfterMs: 7_000,
          definitelyNotAccepted: true,
        },
      });
    });

    it('maps 5xx to unknown instead of assuming the message was not sent', async () => {
      await expect(send('http-500')).resolves.toEqual({
        outcome: 'unknown',
        reason: 'provider_server_error',
      });
    });

    it('maps idempotency conflicts (409) to unknown', async () => {
      await expect(send('http-409-concurrent')).resolves.toEqual({
        outcome: 'unknown',
        reason: 'idempotency_request_in_progress',
      });
      await expect(send('http-409-mismatch')).resolves.toEqual({
        outcome: 'unknown',
        reason: 'idempotency_key_conflict',
      });
    });

    it('maps a success response without message id to unknown', async () => {
      await expect(send('no-id')).resolves.toEqual({
        outcome: 'unknown',
        reason: 'unparsable_response',
      });
    });

    it('maps a connection reset after the request was sent to unknown', async () => {
      await expect(send('reset')).resolves.toMatchObject({ outcome: 'unknown' });
    });

    it('maps connection refused to a certain retryable rejection', async () => {
      const port = await closedPort();
      const result = await adapter.send(
        emailPayload('accept'),
        sendContext(instance(localConfig(`http://127.0.0.1:${port}`))),
      );
      expect(result).toMatchObject({
        outcome: 'rejected',
        error: { kind: 'retryable', code: 'connection_failed', definitelyNotAccepted: true },
      });
    });
  });

  describe('status query', () => {
    const query = (id: string) =>
      adapter.getStatus(id, instance(localConfig(server.baseUrl)), new AbortController().signal);

    it('maps last_event to a normalized receipt', async () => {
      server.statuses.set('re_delivered', { last_event: 'delivered' });
      server.statuses.set('re_sent', { last_event: 'sent' });
      server.statuses.set('re_bounced', { last_event: 'bounced' });
      server.statuses.set('re_queued', { last_event: 'queued' });
      server.statuses.set('re_new', { last_event: 'some_future_event' });

      await expect(query('re_delivered')).resolves.toEqual({
        found: true,
        accepted: true,
        receipt: 'delivered',
      });
      await expect(query('re_sent')).resolves.toEqual({
        found: true,
        accepted: true,
        receipt: 'accepted',
      });
      await expect(query('re_bounced')).resolves.toEqual({
        found: true,
        accepted: true,
        receipt: 'bounced_hard',
      });
      await expect(query('re_queued')).resolves.toEqual({ found: true, accepted: true });
      await expect(query('re_new')).resolves.toEqual({
        found: true,
        accepted: true,
        receipt: 'other',
      });
    });

    it('reports unknown messages as not found', async () => {
      await expect(query('re_missing')).resolves.toEqual({ found: false });
    });
  });

  describe('webhooks', () => {
    it('verifies and parses a signed webhook through the instance secret', async () => {
      const body = Buffer.from(
        JSON.stringify({
          type: 'email.delivered',
          created_at: '2026-10-17T10:00:00.000Z',
          data: { email_id: 're_1', to: ['accept@example.test'], subject: 'Secret subject' },
        }),
      );
      const { signSvixPayload } =
        await import('../../src/infrastructure/providers/email/resend-webhook.js');
      const timestamp = String(Math.floor(Date.now() / 1000));
      const headers = {
        'svix-id': 'msg_1',
        'svix-timestamp': timestamp,
        'svix-signature': `v1,${signSvixPayload(WEBHOOK_SECRET, 'msg_1', timestamp, body)}`,
      };
      const result = await adapter.verifyAndParseWebhook(
        body,
        headers,
        instance(localConfig(server.baseUrl)),
      );
      expect(result).toMatchObject({
        ok: true,
        events: [{ externalEventId: 'msg_1', externalMessageId: 're_1', type: 'delivered' }],
      });
      expect(JSON.stringify(result)).not.toContain('example.test');
    });

    it('fails loudly when the webhook secret is not configured', async () => {
      await expect(
        adapter.verifyAndParseWebhook(
          Buffer.from('{}'),
          {},
          instance(localConfig(server.baseUrl), { apiKey: API_KEY }),
        ),
      ).rejects.toThrow(/secret/i);
    });
  });
});

describe('Resend adapter sender and deployment policy', () => {
  let server: FakeResendServer;
  const adapter = new ResendEmailAdapter();

  beforeAll(async () => {
    server = await startFakeResendServer();
  });
  afterAll(async () => {
    await adapter.close();
    await server.close();
  });

  it('sends `from` rebuilt from the single parsed mailbox', async () => {
    const context = sendContext(instance(localConfig(server.baseUrl)));
    await adapter.send(emailPayloadFrom('Shop (EU) <sender@example.test>'), context);
    expect(server.requests.at(-1)?.body).toMatchObject({
      from: '"Shop (EU)" <sender@example.test>',
    });
    await adapter.send(emailPayloadFrom('  sender@example.test '), sendContext(context.instance));
    expect(server.requests.at(-1)?.body).toMatchObject({ from: 'sender@example.test' });
  });

  it.each(SENDER_BYPASS_PAYLOADS)(
    'refuses the multi-address sender %j without calling the provider',
    async (from) => {
      const before = server.requests.length;
      const result = await adapter.send(
        emailPayloadFrom(from),
        sendContext(instance(localConfig(server.baseUrl))),
      );
      expect(result).toMatchObject({
        outcome: 'rejected',
        error: { kind: 'permanent', code: 'invalid_request', definitelyNotAccepted: true },
      });
      expect(server.requests.length).toBe(before);
    },
  );

  it('refuses profile "local" outside local/test and base URLs outside PROVIDER_ALLOWED_HOSTS', () => {
    const local = { baseUrl: 'http://127.0.0.1:4010', profile: 'local' };
    expect(new ResendEmailAdapter({ environment: 'test' }).validateConfig(local).ok).toBe(true);
    expect(new ResendEmailAdapter({ environment: 'production' }).validateConfig(local)).toEqual({
      ok: false,
      errors: ['/profile "local" is not allowed in production'],
    });
    const restricted = new ResendEmailAdapter({
      environment: 'production',
      allowedHosts: ['.resend.com'],
    });
    expect(restricted.validateConfig({}).ok).toBe(true);
    for (const baseUrl of ['https://resend.attacker.test', 'https://resend.com.attacker.test']) {
      expect(restricted.validateConfig({ baseUrl })).toEqual({
        ok: false,
        errors: ['/baseUrl host is not allowed by PROVIDER_ALLOWED_HOSTS'],
      });
    }
  });
});
