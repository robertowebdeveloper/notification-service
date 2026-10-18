import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PayloadByChannel } from '../../../src/contracts/channels.js';
import type {
  ProviderAdapter,
  ResolvedProviderInstance,
  SendContext,
} from '../../../src/contracts/provider-port.js';

/**
 * Behaviours every email adapter harness must be able to stage, selected through the
 * recipient local part so the same payload shape drives both fake providers.
 */
export type ConformanceBehaviour = 'accept' | 'reject-permanent' | 'reject-retryable' | 'hang';

export interface ConformanceHarness<TConfig> {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  adapter(): ProviderAdapter<'email', TConfig>;
  /** Instance whose send timeout is `timeoutMs`. */
  instance(timeoutMs: number): ResolvedProviderInstance<TConfig>;
  /** Number of submissions observed by the fake provider so far. */
  submissions(): number;
}

export function emailPayload(behaviour: string): PayloadByChannel['email'] {
  return {
    recipient: { email: `${behaviour}@example.test` },
    content: {
      from: 'Notifications <sender@example.test>',
      subject: 'Contract test',
      text: 'Plain body',
      html: '<p>HTML body</p>',
    },
  };
}

let counter = 0;
export function sendContext<TConfig>(
  instance: ResolvedProviderInstance<TConfig>,
  overrides: Partial<Omit<SendContext<TConfig>, 'instance'>> = {},
): SendContext<TConfig> {
  counter += 1;
  return {
    deliveryId: counter,
    createdAt: new Date(),
    attemptId: 1000 + counter,
    idempotencyKey: `delivery-${counter}/send`,
    signal: new AbortController().signal,
    instance,
    ...overrides,
  };
}

const LONG_TIMEOUT_MS = 10_000;
const SHORT_TIMEOUT_MS = 300;

export function runEmailAdapterConformance<TConfig>(harness: ConformanceHarness<TConfig>): void {
  describe(`${harness.name} adapter conformance`, () => {
    let adapter: ProviderAdapter<'email', TConfig>;

    beforeAll(async () => {
      await harness.start();
      adapter = harness.adapter();
    });
    afterAll(async () => {
      await adapter.close?.();
      await harness.stop();
    });

    it('declares the email channel with text and html formats', () => {
      expect(adapter.capabilities.channels).toEqual(['email']);
      expect(adapter.capabilities.platforms).toEqual([]);
      expect(adapter.capabilities.formats).toEqual(expect.arrayContaining(['text', 'html']));
    });

    it('rejects configurations with unknown fields', () => {
      const result = adapter.validateConfig({ unexpectedField: true });
      expect(result.ok).toBe(false);
    });

    it('returns accepted when the provider accepts the message', async () => {
      const result = await adapter.send(
        emailPayload('accept'),
        sendContext(harness.instance(LONG_TIMEOUT_MS)),
      );
      expect(result.outcome).toBe('accepted');
    });

    it('returns a certain permanent rejection when the provider refuses the message', async () => {
      const result = await adapter.send(
        emailPayload('reject-permanent'),
        sendContext(harness.instance(LONG_TIMEOUT_MS)),
      );
      expect(result).toMatchObject({
        outcome: 'rejected',
        error: { kind: 'permanent', definitelyNotAccepted: true },
      });
    });

    it('returns a certain retryable rejection for temporary provider refusals', async () => {
      const result = await adapter.send(
        emailPayload('reject-retryable'),
        sendContext(harness.instance(LONG_TIMEOUT_MS)),
      );
      expect(result).toMatchObject({
        outcome: 'rejected',
        error: { kind: 'retryable', definitelyNotAccepted: true },
      });
    });

    it('returns unknown when the provider times out after the message was submitted', async () => {
      const result = await adapter.send(
        emailPayload('hang'),
        sendContext(harness.instance(SHORT_TIMEOUT_MS)),
      );
      expect(result).toMatchObject({ outcome: 'unknown', reason: 'timeout_after_submission' });
    });

    it('does not contact the provider when the signal is already aborted', async () => {
      const before = harness.submissions();
      const controller = new AbortController();
      controller.abort();
      const result = await adapter.send(
        emailPayload('accept'),
        sendContext(harness.instance(LONG_TIMEOUT_MS), { signal: controller.signal }),
      );
      expect(result).toMatchObject({
        outcome: 'rejected',
        error: { kind: 'retryable', code: 'aborted', definitelyNotAccepted: true },
      });
      expect(harness.submissions()).toBe(before);
    });

    it('returns unknown when aborted after the message was submitted', async () => {
      const controller = new AbortController();
      const pending = adapter.send(
        emailPayload('hang'),
        sendContext(harness.instance(LONG_TIMEOUT_MS), { signal: controller.signal }),
      );
      setTimeout(() => {
        controller.abort();
      }, 200);
      await expect(pending).resolves.toMatchObject({
        outcome: 'unknown',
        reason: 'aborted_after_submission',
      });
    });

    it('never puts recipient addresses in error messages', async () => {
      const result = await adapter.send(
        emailPayload('reject-permanent'),
        sendContext(harness.instance(LONG_TIMEOUT_MS)),
      );
      expect(JSON.stringify(result)).not.toContain('example.test');
    });
  });
}

/**
 * `from` values smuggling a second address next to an allowed one: every adapter must refuse
 * them before contacting the provider (the API rejects them too; this is defence in depth for
 * stored payloads).
 */
export const SENDER_BYPASS_PAYLOADS = [
  '<evil@attacker.test> <sender@example.test>',
  'evil@attacker.test, <sender@example.test>',
  'Notifications <sender@example.test>, evil@attacker.test',
  'evil@attacker.test <sender@example.test>',
  'Notifications\r\nBcc: victim@example.org <sender@example.test>',
] as const;

export function emailPayloadFrom(from: string, behaviour = 'accept'): PayloadByChannel['email'] {
  const payload = emailPayload(behaviour);
  return { ...payload, content: { ...payload.content, from } };
}
