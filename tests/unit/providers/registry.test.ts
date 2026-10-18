import { describe, expect, it } from 'vitest';
import {
  deploymentPolicyFromEnv,
  hostAllowed,
  parseAllowedHosts,
} from '../../../src/infrastructure/providers/deployment-policy.js';
import {
  ProviderRegistry,
  UnknownProviderTypeError,
  createEmailProviderRegistry,
  satisfiesCapabilities,
} from '../../../src/infrastructure/providers/registry.js';

describe('provider registry', () => {
  const registry = createEmailProviderRegistry();

  it('registers the email adapters by provider type', () => {
    expect(registry.providerTypes().sort()).toEqual(['resend', 'smtp']);
    expect(registry.forChannel('smtp', 'email')?.providerType).toBe('smtp');
    expect(registry.forChannel('smtp', 'sms')).toBeUndefined();
    expect(() => registry.get('unknown')).toThrow(UnknownProviderTypeError);
  });

  it('refuses duplicate registrations', () => {
    const smtp = registry.get('smtp');
    expect(() => new ProviderRegistry([smtp, smtp])).toThrow(/already registered/);
  });

  it('filters by capabilities rather than provider names', () => {
    const email = { channel: 'email' } as const;
    expect(registry.supports('smtp', email)).toBe(true);
    expect(registry.supports('smtp', { ...email, idempotency: true })).toBe(false);
    expect(registry.supports('resend', { ...email, minIdempotencyWindowSeconds: 3_600 })).toBe(
      true,
    );
    expect(registry.supports('resend', { ...email, minIdempotencyWindowSeconds: 90_000 })).toBe(
      false,
    );
    expect(registry.supports('resend', { ...email, receipts: true, statusQuery: true })).toBe(true);
    expect(registry.supports('resend', { ...email, format: 'template' })).toBe(false);
    expect(registry.supports('smtp', { channel: 'push', platform: 'fcm' })).toBe(false);
    expect(registry.supports('missing', email)).toBe(false);
  });

  it('validates configuration through the adapter', () => {
    expect(registry.validateConfig('smtp', { host: 'smtp.example.test', port: 587 }).ok).toBe(true);
    expect(registry.validateConfig('smtp', { host: 'smtp.example.test' }).ok).toBe(false);
    expect(registry.validateConfig('nope', {})).toEqual({
      ok: false,
      errors: ['unknown provider type "nope"'],
    });
  });

  it('derives required secrets from the validated configuration', () => {
    const plain = registry.validateConfig('smtp', { host: 'smtp.example.test', port: 587 });
    const auth = registry.validateConfig('smtp', {
      host: 'smtp.example.test',
      port: 587,
      auth: true,
    });
    if (!plain.ok || !auth.ok) throw new Error('invalid fixture');
    expect(registry.requiredSecretsFor('smtp', plain.config)).toEqual([]);
    expect(registry.requiredSecretsFor('smtp', auth.config)).toEqual(['username', 'password']);
    expect(registry.requiredSecretsFor('resend', {})).toEqual(['apiKey', 'webhookSecret']);
  });

  it('closes every adapter', async () => {
    await expect(registry.closeAll()).resolves.toBeUndefined();
  });

  it('matches capability requirements independently of any registry', () => {
    expect(
      satisfiesCapabilities(registry.capabilities('resend'), { channel: 'email', format: 'html' }),
    ).toBe(true);
  });
});

describe('deployment policy at runtime resolution', () => {
  const localSmtp = {
    host: 'mailpit',
    port: 1025,
    profile: 'local',
    tlsRequired: false,
    requireTLS: false,
  };

  it('treats stored profile "local" instances as invalid configuration outside local/test', () => {
    for (const environment of ['stage', 'production']) {
      const registry = createEmailProviderRegistry({ environment });
      expect(registry.validateConfig('smtp', localSmtp)).toEqual({
        ok: false,
        errors: [`/profile "local" is not allowed in ${environment}`],
      });
      // The worker's resolver calls the adapter directly: same outcome.
      expect(
        registry.get('resend').validateConfig({ baseUrl: 'http://x.test', profile: 'local' }).ok,
      ).toBe(false);
    }
    expect(
      createEmailProviderRegistry({ environment: 'test' }).validateConfig('smtp', localSmtp).ok,
    ).toBe(true);
  });

  it('reads APP_ENV and PROVIDER_ALLOWED_HOSTS from the environment by default', () => {
    expect(
      deploymentPolicyFromEnv({
        APP_ENV: 'production',
        PROVIDER_ALLOWED_HOSTS: ' A.test, .b.test ,',
      }),
    ).toEqual({
      environment: 'production',
      allowedHosts: ['a.test', '.b.test'],
    });
    expect(deploymentPolicyFromEnv({})).toEqual({
      environment: undefined,
      allowedHosts: undefined,
    });
  });

  it('matches allowed hosts exactly or by dot-suffix only', () => {
    const allowed = parseAllowedHosts('smtp.example.com,.resend.com');
    expect(hostAllowed('smtp.example.com', allowed)).toBe(true);
    expect(hostAllowed('api.resend.com', allowed)).toBe(true);
    expect(hostAllowed('resend.com', allowed)).toBe(false);
    expect(hostAllowed('evilresend.com', allowed)).toBe(false);
    expect(hostAllowed('anything', undefined)).toBe(true);
    expect(parseAllowedHosts(' , ')).toBeUndefined();
  });
});
