import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';
import type { ConfigValidationResult } from '../../contracts/provider-port.js';

/**
 * Applies schema defaults to a copy of `input` and validates it. Error messages contain
 * paths and constraint descriptions only, never the submitted values.
 */
export function validateWithSchema<S extends TSchema>(
  schema: S,
  input: unknown,
): ConfigValidationResult<Static<S>> {
  const candidate: unknown = Value.Default(schema, structuredClone(input));
  if (!Value.Check(schema, candidate)) {
    const errors = [...Value.Errors(schema, candidate)].map(
      (issue) => `${issue.instancePath || '/'} ${issue.message}`,
    );
    return { ok: false, errors: [...new Set(errors)] };
  }
  return { ok: true, config: candidate };
}
