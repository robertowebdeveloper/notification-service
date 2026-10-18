import { UniqueConstraintViolationException } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { InvalidCursorError } from '../../application/ports/lookup-repositories.js';

/** Row shape returned by raw queries (column name -> value). */
export type Row = Record<string, unknown>;

export type Orm = MikroORM;

/**
 * Forked EntityManager for a single repository operation: never share the identity map
 * between concurrent operations.
 */
export function forkEm(orm: Orm) {
  return orm.em.fork({ clear: true, useContext: false });
}

export type Em = ReturnType<typeof forkEm>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids coming from HTTP paths may be arbitrary strings; avoid PostgreSQL cast errors. */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (!(error instanceof UniqueConstraintViolationException)) return false;
  if (constraint === undefined) return true;
  return (
    (error as UniqueConstraintViolationException & { constraint?: string }).constraint ===
    constraint
  );
}

/**
 * The PostgreSQL driver returns timestamptz as text ("2026-10-17 21:34:06.79+00").
 * Columns are timestamptz(3), so the conversion is lossless.
 */
export function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value !== 'string') throw new TypeError(`Expected timestamp, got ${typeof value}`);
  let iso = value.replace(' ', 'T');
  if (/[+-]\d{2}$/.test(iso)) iso += ':00';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) throw new TypeError(`Invalid timestamp: ${value}`);
  return date;
}

export function toDateOrNull(value: unknown): Date | null {
  return value === null || value === undefined ? null : toDate(value);
}

export function str(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError(`Expected string, got ${typeof value}`);
  return value;
}

export function strOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : str(value);
}

export function num(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value !== '' && !Number.isNaN(Number(value))) {
    return Number(value);
  }
  throw new TypeError(`Expected number, got ${typeof value}`);
}

export function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`Expected boolean, got ${typeof value}`);
  return value;
}

/** Converts a JS array into a PostgreSQL array literal (MikroORM expands raw array params). */
export function pgTextArray(values: readonly string[]): string {
  return `{${values.map((v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
}

export function parsePgTextArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(str);
  if (typeof value !== 'string') throw new TypeError('Expected text[]');
  const inner = value.replace(/^\{|\}$/g, '');
  if (inner === '') return [];
  return inner.split(',').map((v) => v.replace(/^"|"$/g, ''));
}

export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

/** Opaque keyset cursor: base64url of [createdAt ISO, id]. */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([createdAt.toISOString(), id]), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && parsed.length === 2) {
      const [createdAt, id] = parsed as unknown[];
      if (typeof createdAt === 'string' && typeof id === 'string' && isUuid(id)) {
        const date = new Date(createdAt);
        if (!Number.isNaN(date.getTime())) return { createdAt: date, id };
      }
    }
  } catch {
    // fall through
  }
  throw new InvalidCursorError();
}

/** Thrown inside a transaction callback to roll back when a fenced update matched nothing. */
export class FencingRollback extends Error {
  constructor() {
    super('fenced update did not match');
    this.name = 'FencingRollback';
  }
}
