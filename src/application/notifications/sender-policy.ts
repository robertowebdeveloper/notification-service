import { parseMailbox } from '../../contracts/email-address.js';

/**
 * Allowed sender rules (configured per tenant by operators):
 * - `user@example.com`  exact mailbox (case-insensitive)
 * - `@example.com`      any mailbox of exactly that domain (no subdomains)
 * An empty list allows nothing.
 *
 * `from` must be exactly one mailbox (see `parseMailbox`): the adapters send from the very same
 * parsed address, so the policy can never be checked against a different address than the one
 * used by the transport.
 */

/** The single sender address of `from`, lower-cased; null when `from` is not one mailbox. */
export function senderAddress(from: string): string | null {
  const mailbox = parseMailbox(from);
  return mailbox === null ? null : mailbox.address.toLowerCase();
}

export function isSenderAllowed(from: string, allowed: readonly string[]): boolean {
  const address = senderAddress(from);
  if (address === null) return false;
  const domain = address.slice(address.lastIndexOf('@'));
  return allowed.some((rule) => {
    const normalized = rule.trim().toLowerCase();
    return normalized.startsWith('@') ? normalized === domain : normalized === address;
  });
}
