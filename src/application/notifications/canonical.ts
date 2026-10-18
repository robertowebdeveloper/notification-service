import { createHash } from 'node:crypto';

/** Deterministic JSON: object keys sorted recursively, arrays kept in order, undefined dropped. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return value === undefined ? 'null' : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => stableStringify(item ?? null)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

export interface CanonicalRequest {
  routingKey: string;
  channel: string;
  recipient: unknown;
  content: unknown;
  metadata: Record<string, unknown>;
}

/** SHA-256 of the canonical request body (no secrets are part of the request). */
export function requestHash(request: CanonicalRequest): string {
  const canonical = stableStringify({
    channel: request.channel,
    content: request.content,
    metadata: request.metadata,
    recipient: request.recipient,
    routingKey: request.routingKey,
  });
  return 'sha256:' + createHash('sha256').update(canonical, 'utf8').digest('hex');
}
