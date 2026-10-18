import { describe, expect, it } from 'vitest';
import {
  generateApiKey,
  hashApiKey,
  parseApiKey,
  verifyApiKey,
} from '../../../src/infrastructure/security/api-keys.js';

describe('api keys', () => {
  it('generates ns_<prefix>_<secret> keys whose hash is stored, never the key', () => {
    const key = generateApiKey();
    expect(key.plaintext).toMatch(/^ns_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    expect(parseApiKey(key.plaintext)).toEqual({ keyPrefix: key.keyPrefix });
    expect(key.keyHash).toBe(hashApiKey(key.plaintext));
    expect(key.keyHash).not.toContain(key.plaintext.slice(16));
    expect(generateApiKey().plaintext).not.toBe(key.plaintext);
  });

  it('verifies only the exact key against its hash', () => {
    const key = generateApiKey();
    expect(verifyApiKey(key.plaintext, key.keyHash)).toBe(true);
    expect(verifyApiKey(key.plaintext + 'x', key.keyHash)).toBe(false);
    expect(verifyApiKey(generateApiKey().plaintext, key.keyHash)).toBe(false);
    expect(verifyApiKey(key.plaintext, null)).toBe(false);
    expect(verifyApiKey(key.plaintext, 'plain-text-hash')).toBe(false);
  });

  it('rejects malformed keys at parse time', () => {
    for (const value of ['', 'ns_short_secret', `xx_0123456789ab_${'a'.repeat(43)}`]) {
      expect(parseApiKey(value)).toBeNull();
    }
  });
});
