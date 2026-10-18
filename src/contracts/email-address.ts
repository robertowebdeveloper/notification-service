/**
 * Strict single-mailbox grammar for `content.from`, shared by the HTTP schema, the sender
 * allow-list and the email adapters, so the address checked by the policy is exactly the address
 * the transport uses.
 *
 * Accepted forms (nothing else):
 * - `user@example.com`
 * - `Display Name <user@example.com>`
 * - `"Display Name" <user@example.com>`
 *
 * Rejected: address lists (`,` or `;`), groups, more than one `<...>`, comments after the
 * address, `@ < > " \` inside the display name, control characters (CR/LF included), IP-literal
 * domains and quoted local parts.
 */

const ATEXT = "A-Za-z0-9!#$%&'*+/=?^_`{|}~-";
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
/** dot-atom local part @ hostname with at least two labels. */
export const ADDRESS_PATTERN_SOURCE = `[${ATEXT}]+(?:\\.[${ATEXT}]+)*@(?:${LABEL}\\.)+${LABEL}`;
/** Characters allowed in a display name (quoted or not). */
const NAME_CHAR = '[^"\\\\<>@,;\\x00-\\x1f\\x7f]';

/** JSON-Schema pattern (valid with and without the `u` flag) of a single mailbox. */
export const MAILBOX_PATTERN_SOURCE =
  `^(?:${ADDRESS_PATTERN_SOURCE}` +
  `|(?:"${NAME_CHAR}*" *|${NAME_CHAR}*)<${ADDRESS_PATTERN_SOURCE}>)$`;

const ADDRESS_RE = new RegExp(`^${ADDRESS_PATTERN_SOURCE}$`);
const BARE_RE = new RegExp(`^(${ADDRESS_PATTERN_SOURCE})$`);
const QUOTED_RE = new RegExp(`^"(${NAME_CHAR}*)" *<(${ADDRESS_PATTERN_SOURCE})>$`);
const UNQUOTED_RE = new RegExp(`^(${NAME_CHAR}*)<(${ADDRESS_PATTERN_SOURCE})>$`);

const MAX_ADDRESS_LENGTH = 254;
const MAX_LOCAL_PART_LENGTH = 64;
const MAX_NAME_LENGTH = 256;

export interface Mailbox {
  /** Display name without quotes; absent when empty. */
  name?: string;
  /** The only address of the mailbox, as submitted (case preserved). */
  address: string;
}

function validAddress(address: string): boolean {
  if (address.length > MAX_ADDRESS_LENGTH || !ADDRESS_RE.test(address)) return false;
  return address.indexOf('@') <= MAX_LOCAL_PART_LENGTH;
}

/** Parses exactly one mailbox; null for anything else (lists, groups, injections...). */
export function parseMailbox(input: string): Mailbox | null {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  const bare = BARE_RE.exec(value);
  if (bare?.[1] !== undefined) return validAddress(bare[1]) ? { address: bare[1] } : null;
  const match = QUOTED_RE.exec(value) ?? UNQUOTED_RE.exec(value);
  const rawName = match?.[1];
  const address = match?.[2];
  if (rawName === undefined || address === undefined || !validAddress(address)) return null;
  const name = rawName.trim().replace(/ {2,}/g, ' ');
  if (name.length > MAX_NAME_LENGTH) return null;
  return name === '' ? { address } : { name, address };
}

/** RFC 5322 specials that force a quoted display name (`"` and `\` cannot occur). */
const NEEDS_QUOTES = /[()[\]:.]/;

/** Canonical header form of a parsed mailbox. */
export function formatMailbox(mailbox: Mailbox): string {
  if (mailbox.name === undefined) return mailbox.address;
  const name = NEEDS_QUOTES.test(mailbox.name) ? `"${mailbox.name}"` : mailbox.name;
  return `${name} <${mailbox.address}>`;
}

/** Lower-cased domain of a parsed address. */
export function mailboxDomain(mailbox: Mailbox): string {
  return mailbox.address.slice(mailbox.address.lastIndexOf('@') + 1).toLowerCase();
}
