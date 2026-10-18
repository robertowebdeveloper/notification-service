import { describe, expect, it } from 'vitest';
import type { ProviderCapabilities } from '../../../src/contracts/provider-port.js';
import {
  candidateOrder,
  capabilitiesCover,
  excludedInstances,
  isFallbackEligible,
  payloadRequirements,
  type AttemptFacts,
} from '../../../src/domain/provider-eligibility.js';

const smtpLike: ProviderCapabilities = {
  channels: ['email'],
  platforms: [],
  formats: ['text', 'html'],
  idempotency: { supported: false },
  receipts: false,
  statusQuery: false,
};
const textOnly: ProviderCapabilities = { ...smtpLike, formats: ['text'] };
const idempotent: ProviderCapabilities = {
  ...smtpLike,
  idempotency: { supported: true, windowSeconds: 86_400 },
};

const configRejection: AttemptFacts = {
  providerInstanceId: 1,
  outcome: 'rejected',
  errorKind: 'configuration',
};

describe('payload requirements and capabilities', () => {
  it('requires every content format present in the email', () => {
    const requirements = payloadRequirements({
      channel: 'email',
      recipient: { email: 'x@example.test' },
      content: { from: 'f@example.test', subject: 's', text: 't', html: '<p>h</p>' },
    });
    expect(requirements).toEqual({ channel: 'email', platform: null, formats: ['text', 'html'] });
    expect(capabilitiesCover(smtpLike, requirements)).toBe(true);
    expect(capabilitiesCover(textOnly, requirements)).toBe(false);
  });

  it('requires the same platform for push and messaging', () => {
    const requirements = payloadRequirements({
      channel: 'messaging',
      recipient: { platform: 'telegram', chatId: '42' },
      content: { type: 'text', text: 'hi' },
    });
    const whatsappOnly: ProviderCapabilities = {
      ...smtpLike,
      channels: ['messaging'],
      platforms: ['whatsapp'],
      formats: ['text'],
    };
    expect(capabilitiesCover(whatsappOnly, requirements)).toBe(false);
    expect(capabilitiesCover({ ...whatsappOnly, platforms: ['telegram'] }, requirements)).toBe(
      true,
    );
  });

  it('can require idempotency (safe replays)', () => {
    const requirements = { channel: 'email' as const, platform: null, formats: ['text'] };
    expect(capabilitiesCover(smtpLike, requirements, { requireIdempotency: true })).toBe(false);
    expect(capabilitiesCover(idempotent, requirements, { requireIdempotency: true })).toBe(true);
  });
});

describe('fallback rules', () => {
  it('excludes only instances that rejected for configuration', () => {
    const history: AttemptFacts[] = [
      configRejection,
      { providerInstanceId: 2, outcome: 'rejected', errorKind: 'retryable' },
      { providerInstanceId: 3, outcome: 'unknown', errorKind: null },
    ];
    expect([...excludedInstances(history)]).toEqual([1]);
  });

  it('orders candidates by snapshot and honours a disabled fallback', () => {
    expect(candidateOrder([1, 2, 3], new Set([1]), true)).toEqual([2, 3]);
    expect(candidateOrder([1, 2, 3], new Set(), false)).toEqual([1]);
    expect(candidateOrder([1, 2], new Set([1]), false)).toEqual([]);
  });

  const base = {
    currentInstanceId: 1,
    snapshotInstanceIds: [1, 2],
    history: [] as AttemptFacts[],
    fallbackEnabled: true,
    attemptsUsed: 1,
    maxAttempts: 5,
  };

  it('allows fallback after a certain configuration rejection with another provider', () => {
    expect(
      isFallbackEligible({
        ...base,
        error: { kind: 'configuration', definitelyNotAccepted: true },
      }),
    ).toBe(true);
  });

  it('never falls back on retryable, permanent or uncertain errors', () => {
    expect(
      isFallbackEligible({ ...base, error: { kind: 'retryable', definitelyNotAccepted: true } }),
    ).toBe(false);
    expect(
      isFallbackEligible({ ...base, error: { kind: 'permanent', definitelyNotAccepted: true } }),
    ).toBe(false);
    expect(
      isFallbackEligible({
        ...base,
        error: { kind: 'configuration', definitelyNotAccepted: false },
      }),
    ).toBe(false);
  });

  it('respects the global budget, the policy flag and the remaining candidates', () => {
    const error = { kind: 'configuration' as const, definitelyNotAccepted: true };
    expect(isFallbackEligible({ ...base, error, attemptsUsed: 5 })).toBe(false);
    expect(isFallbackEligible({ ...base, error, fallbackEnabled: false })).toBe(false);
    expect(
      isFallbackEligible({
        ...base,
        error,
        currentInstanceId: 2,
        history: [configRejection],
      }),
    ).toBe(false);
  });
});
