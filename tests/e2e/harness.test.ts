import { createTransport } from 'nodemailer';
import { describe, expect, it } from 'vitest';
import { verifyAndParseResendWebhook } from '../../src/infrastructure/providers/email/resend-webhook.js';
import { resendBehaviours } from './support/fake-resend.js';
import { useE2eSystem } from './support/lifecycle.js';
import { uniqueRecipient } from './support/payloads.js';
import { extractApiKeys } from './support/seed.js';
import { delay, waitFor } from './support/wait-for.js';
import { generateWebhookSecret, signedResendWebhook } from './support/webhooks.js';

/** Self-tests of the e2e harness: they do not depend on phase 2A/2B features. */
describe('e2e harness', () => {
  const system = useE2eSystem(2);

  it('creates an isolated database migrated by the real migrate entrypoint', async () => {
    const tables = await system().db.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const names = tables.map((t) => t.table_name);
    for (const table of ['tenants', 'notifications', 'deliveries', 'outbox_events']) {
      expect(names).toContain(table);
    }
    expect(system().databaseName).toBe('notifications_e2e_2');
    expect(await system().queue.keyCount()).toBe(0);
  });

  it('reaches the shared Mailpit instance', async () => {
    await system().mailpit.ping();
  });

  it('starts, observes and kills real service processes', async () => {
    const api = await system().startApi();
    const live = await fetch(`${system().apiUrl}/health/live`);
    expect(live.status).toBe(200);
    const dispatcher = await system().startDispatcher();
    const exit = await dispatcher.kill();
    expect(exit.signal).toBe('SIGKILL');
    const stopped = await api.stop('SIGTERM');
    expect(stopped.code).toBe(0);
  }, 90_000);

  it('fake SMTP follows the programmed behaviours and records every transaction', async () => {
    const smtp = system().smtp;
    const transport = createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: false,
      ignoreTLS: true,
    });
    const send = (to: string) =>
      transport.sendMail({ from: 'sender@example.test', to, subject: 's', text: 't' });

    const retryable = uniqueRecipient('fake');
    smtp.program(retryable, ['rcpt-451', 'accept']);
    await expect(send(retryable)).rejects.toMatchObject({ responseCode: 451 });
    await send(retryable);
    expect(smtp.sendAttempts(retryable)).toBe(2);
    expect(smtp.acceptedMessages(retryable)).toHaveLength(1);

    const held = uniqueRecipient('fake');
    smtp.program(held, ['hold']);
    let settled = false;
    const pending = send(held).then(() => (settled = true));
    await waitFor(() => smtp.potentialDeliveries(held) === 1, {
      timeoutMs: 5_000,
      description: 'held body received',
    });
    await delay(300);
    expect(settled).toBe(false);
    expect(smtp.release(held)).toBe(1);
    await pending;
    expect(smtp.acceptedMessages(held)).toHaveLength(1);
    transport.close();
  });

  it('fake Resend is idempotent per key and supports hold, 409 and Retry-After', async () => {
    const resend = system().resend;
    const post = (to: string, key: string) =>
      fetch(`${resend.baseUrl}/emails`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({ to: [to], from: 'sender@example.test', subject: 's' }),
      });

    const accepted = uniqueRecipient('fake');
    const first = (await (await post(accepted, 'k1')).json()) as { id: string };
    const replay = (await (await post(accepted, 'k1')).json()) as { id: string };
    expect(replay.id).toBe(first.id);
    expect(resend.idempotencyKeys(accepted)).toEqual(['k1']);

    const limited = uniqueRecipient('fake');
    resend.program(limited, [resendBehaviours.rateLimited(7), resendBehaviours.accept]);
    const limitedResponse = await post(limited, 'k2');
    expect(limitedResponse.status).toBe(429);
    expect(limitedResponse.headers.get('retry-after')).toBe('7');
    expect((await post(limited, 'k2')).status).toBe(200);

    const held = uniqueRecipient('fake');
    resend.program(held, [resendBehaviours.hold, resendBehaviours.accept]);
    const heldResponse = post(held, 'k3');
    await waitFor(() => resend.sends(held).length === 1, {
      timeoutMs: 5_000,
      description: 'held request received',
    });
    expect((await post(held, 'k3')).status).toBe(409);
    const heldId = resend.sends(held)[0]?.emailId;
    expect(resend.release(held)).toBe(1);
    expect(((await (await heldResponse).json()) as { id: string }).id).toBe(heldId);
  });

  it('signs webhooks exactly as the Resend verifier expects', () => {
    const secret = generateWebhookSecret();
    const webhook = signedResendWebhook(secret, { type: 'email.delivered', emailId: 're_1' });
    const parsed = verifyAndParseResendWebhook(
      Buffer.from(webhook.rawBody),
      webhook.headers,
      secret,
    );
    expect(parsed).toMatchObject({
      ok: true,
      events: [{ externalEventId: webhook.eventId, externalMessageId: 're_1', type: 'delivered' }],
    });
  });

  it('extracts API keys printed by config:apply in JSON or text form', () => {
    const key = 'nsk_live_0123456789abcdefghijklmnop';
    expect(
      extractApiKeys(JSON.stringify({ msg: 'api key created', name: 'e2e-primary', key }), [
        'e2e-primary',
      ]),
    ).toEqual({ 'e2e-primary': key });
    expect(
      extractApiKeys(JSON.stringify({ apiKeys: [{ name: 'e2e-primary', apiKey: key }] }), [
        'e2e-primary',
      ]),
    ).toEqual({ 'e2e-primary': key });
    expect(extractApiKeys(`tenant e2e-x api key e2e-primary: ${key}`, ['e2e-primary'])).toEqual({
      'e2e-primary': key,
    });
    expect(extractApiKeys('nothing here', ['e2e-primary'])).toEqual({});
  });
});
