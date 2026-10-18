import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * API key format: `ns_<prefix>_<secret>`
 * - `prefix`: 12 lowercase hex chars (6 random bytes), stored in clear in `api_keys.key_prefix`
 *   and used only to look the key up (non-secret, unique).
 * - `secret`: 32 random bytes, base64url (43 chars, may contain `-` and `_`).
 *
 * Only `sha256:<hex>` of the whole key string is stored. The secret carries 256 bits of entropy,
 * so a fast hash is sufficient (no offline guessing is feasible); comparisons are timing-safe.
 * A server-side pepper (HMAC) can be introduced later by adding a new hash scheme prefix.
 */
export const API_KEY_PREFIX = 'ns';
const KEY_PATTERN = /^ns_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
const HASH_SCHEME = 'sha256:';

export interface GeneratedApiKey {
  /** Full key, shown once to the operator and never stored. */
  plaintext: string;
  keyPrefix: string;
  keyHash: string;
}

export function hashApiKey(plaintext: string): string {
  return HASH_SCHEME + createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

export function generateApiKey(): GeneratedApiKey {
  const keyPrefix = randomBytes(6).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  const plaintext = `${API_KEY_PREFIX}_${keyPrefix}_${secret}`;
  return { plaintext, keyPrefix, keyHash: hashApiKey(plaintext) };
}

/** Returns the lookup prefix of a well-formed key, or null. */
export function parseApiKey(plaintext: string): { keyPrefix: string } | null {
  const match = KEY_PATTERN.exec(plaintext);
  return match?.[1] === undefined ? null : { keyPrefix: match[1] };
}

const DUMMY_HASH = hashApiKey('ns_000000000000_' + 'A'.repeat(43));

/**
 * Timing-safe verification of a presented key against a stored hash. Pass `storedHash: null`
 * when no record was found, so unknown prefixes cost the same work as known ones.
 */
export function verifyApiKey(plaintext: string, storedHash: string | null): boolean {
  const expected = Buffer.from(storedHash ?? DUMMY_HASH, 'utf8');
  const actual = Buffer.from(hashApiKey(plaintext), 'utf8');
  const equal = expected.length === actual.length && timingSafeEqual(expected, actual);
  return storedHash !== null && storedHash.startsWith(HASH_SCHEME) && equal;
}
