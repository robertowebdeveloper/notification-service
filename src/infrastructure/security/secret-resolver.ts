import { open } from 'node:fs/promises';
import path from 'node:path';
import type { SecretValues } from '../../contracts/provider-port.js';

/**
 * Resolves the secret values of a provider instance from its `secret_ref`.
 *
 * Supported references:
 * - `env:<PREFIX>`  -> environment variable `<PREFIX>_<KEY>` with the key in UPPER_SNAKE_CASE
 *                      (`env:RESEND_MAIN` + `apiKey` -> `RESEND_MAIN_API_KEY`).
 * - `file:<name>`   -> file `<SECRETS_DIR>/<name>_<key>` with the key in lower_snake_case
 *                      (`file:resend_main` + `apiKey` -> `/run/secrets/resend_main_api_key`),
 *                      matching flat Docker secrets.
 *
 * Further backends (e.g. a secret manager) plug in as additional `SecretBackend` schemes.
 * Values never appear in errors or logs; errors only name the reference and the key.
 */
export interface SecretResolver {
  resolve(secretRef: string, keys: readonly string[]): Promise<SecretValues>;
}

export interface SecretBackend {
  readonly scheme: string;
  /** Returns the value or undefined when the key is not present. */
  read(locator: string, key: string): Promise<string | undefined>;
}

export type SecretResolutionErrorCode =
  'invalid_ref' | 'unsupported_scheme' | 'missing_secret' | 'unreadable_secret';

export class SecretResolutionError extends Error {
  constructor(
    readonly code: SecretResolutionErrorCode,
    readonly secretRef: string,
    readonly key?: string,
  ) {
    super(
      key === undefined
        ? `Secret reference "${secretRef}" cannot be resolved (${code})`
        : `Secret "${key}" of reference "${secretRef}" cannot be resolved (${code})`,
    );
    this.name = 'SecretResolutionError';
  }
}

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const MAX_SECRET_FILE_BYTES = 64 * 1024;

function snakeCase(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

/** Thrown by backends for a locator they cannot accept; mapped to `invalid_ref`. */
class InvalidLocatorError extends Error {}

export class EnvSecretBackend implements SecretBackend {
  readonly scheme = 'env';
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  read(locator: string, key: string): Promise<string | undefined> {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(locator)) throw new InvalidLocatorError();
    const value = this.env[`${locator}_${snakeCase(key).toUpperCase()}`];
    return Promise.resolve(value === undefined || value === '' ? undefined : value);
  }
}

export class FileSecretBackend implements SecretBackend {
  readonly scheme = 'file';
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = path.resolve(directory);
  }

  async read(locator: string, key: string): Promise<string | undefined> {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(locator)) throw new InvalidLocatorError();
    const file = path.join(this.directory, `${locator}_${snakeCase(key)}`);
    if (path.dirname(file) !== this.directory) throw new InvalidLocatorError();
    let handle;
    try {
      handle = await open(file, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > MAX_SECRET_FILE_BYTES) {
        throw new Error('secret file is not a regular file of acceptable size');
      }
      const value = (await handle.readFile('utf8')).replace(/\r?\n$/, '');
      return value === '' ? undefined : value;
    } finally {
      await handle.close();
    }
  }
}

export class SecretRefResolver implements SecretResolver {
  private readonly backends = new Map<string, SecretBackend>();

  constructor(backends: Iterable<SecretBackend>) {
    for (const backend of backends) this.backends.set(backend.scheme, backend);
  }

  async resolve(secretRef: string, keys: readonly string[]): Promise<SecretValues> {
    const separator = secretRef.indexOf(':');
    if (separator <= 0 || separator === secretRef.length - 1) {
      throw new SecretResolutionError('invalid_ref', secretRef);
    }
    const scheme = secretRef.slice(0, separator);
    const locator = secretRef.slice(separator + 1);
    const backend = this.backends.get(scheme);
    if (backend === undefined) throw new SecretResolutionError('unsupported_scheme', secretRef);

    const values = new Map<string, string>();
    for (const key of keys) {
      if (!KEY_PATTERN.test(key)) throw new SecretResolutionError('invalid_ref', secretRef, key);
      let value: string | undefined;
      try {
        value = await backend.read(locator, key);
      } catch (error) {
        throw new SecretResolutionError(
          error instanceof InvalidLocatorError ? 'invalid_ref' : 'unreadable_secret',
          secretRef,
          key,
        );
      }
      if (value === undefined) throw new SecretResolutionError('missing_secret', secretRef, key);
      values.set(key, value);
    }
    return values;
  }
}

export interface SecretResolverOptions {
  env?: NodeJS.ProcessEnv;
  /** Docker secrets directory (`SECRETS_DIR`); the `file:` scheme is disabled when absent. */
  secretsDir?: string | undefined;
}

export function createSecretResolver(options: SecretResolverOptions = {}): SecretResolver {
  const backends: SecretBackend[] = [new EnvSecretBackend(options.env ?? process.env)];
  if (options.secretsDir !== undefined) backends.push(new FileSecretBackend(options.secretsDir));
  return new SecretRefResolver(backends);
}
