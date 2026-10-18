import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SecretRefResolver,
  SecretResolutionError,
  createSecretResolver,
  type SecretBackend,
} from '../../../src/infrastructure/security/secret-resolver.js';

describe('secret resolver', () => {
  let secretsDir: string;

  beforeAll(async () => {
    secretsDir = await mkdtemp(path.join(tmpdir(), 'ns-secrets-'));
    await writeFile(path.join(secretsDir, 'resend_main_api_key'), 'file-api-key\n');
    await writeFile(path.join(secretsDir, 'resend_main_webhook_secret'), 'whsec_file');
    await writeFile(path.join(secretsDir, 'empty_api_key'), '\n');
    await mkdir(path.join(secretsDir, 'dir_api_key'));
  });
  afterAll(async () => {
    await rm(secretsDir, { recursive: true, force: true });
  });

  const resolver = () =>
    createSecretResolver({
      env: {
        RESEND_MAIN_API_KEY: 'env-api-key',
        RESEND_MAIN_WEBHOOK_SECRET: 'whsec_env',
        EMPTY_API_KEY: '',
      },
      secretsDir,
    });

  const failure = async (promise: Promise<unknown>) => {
    const error: unknown = await promise.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(SecretResolutionError);
    return error as SecretResolutionError;
  };

  it('resolves keys from environment variables in upper snake case', async () => {
    const values = await resolver().resolve('env:RESEND_MAIN', ['apiKey', 'webhookSecret']);
    expect(Object.fromEntries(values)).toEqual({
      apiKey: 'env-api-key',
      webhookSecret: 'whsec_env',
    });
  });

  it('resolves keys from Docker secret files, trimming the trailing newline', async () => {
    const values = await resolver().resolve('file:resend_main', ['apiKey', 'webhookSecret']);
    expect(Object.fromEntries(values)).toEqual({
      apiKey: 'file-api-key',
      webhookSecret: 'whsec_file',
    });
  });

  it('returns an empty map when no keys are requested', async () => {
    expect((await resolver().resolve('env:ANY', [])).size).toBe(0);
  });

  it('reports missing and empty secrets without exposing values', async () => {
    const missingEnv = await failure(resolver().resolve('env:RESEND_MAIN', ['password']));
    expect(missingEnv).toMatchObject({ code: 'missing_secret', key: 'password' });
    expect((await failure(resolver().resolve('env:EMPTY', ['apiKey']))).code).toBe(
      'missing_secret',
    );
    expect((await failure(resolver().resolve('file:empty', ['apiKey']))).code).toBe(
      'missing_secret',
    );
    expect((await failure(resolver().resolve('file:absent', ['apiKey']))).code).toBe(
      'missing_secret',
    );

    const partial = await failure(resolver().resolve('env:RESEND_MAIN', ['apiKey', 'password']));
    expect(partial.message).not.toContain('env-api-key');
  });

  it('rejects malformed references and path traversal', async () => {
    for (const ref of [
      '',
      'RESEND',
      'env:',
      ':x',
      'env:lower',
      'file:../etc',
      'file:a/b',
      'file:.hidden',
    ]) {
      expect((await failure(resolver().resolve(ref, ['apiKey']))).code).toBe('invalid_ref');
    }
    expect((await failure(resolver().resolve('env:OK', ['../x']))).code).toBe('invalid_ref');
  });

  it('rejects unknown schemes and the file scheme when no secrets directory is configured', async () => {
    expect((await failure(resolver().resolve('vault:path', ['apiKey']))).code).toBe(
      'unsupported_scheme',
    );
    const envOnly = createSecretResolver({ env: {} });
    expect((await failure(envOnly.resolve('file:resend_main', ['apiKey']))).code).toBe(
      'unsupported_scheme',
    );
  });

  it('reports unreadable secret files', async () => {
    expect((await failure(resolver().resolve('file:dir', ['apiKey']))).code).toBe(
      'unreadable_secret',
    );
  });

  it('supports additional backends such as a future secret manager', async () => {
    const manager: SecretBackend = {
      scheme: 'vault',
      read: (locator, key) =>
        Promise.resolve(locator === 'team/resend' ? `${key}-from-vault` : undefined),
    };
    const values = await new SecretRefResolver([manager]).resolve('vault:team/resend', ['apiKey']);
    expect(values.get('apiKey')).toBe('apiKey-from-vault');
  });

  it('does not leak backend error details', async () => {
    const failing: SecretBackend = {
      scheme: 'broken',
      read: () => Promise.reject(new Error('connection string with password=hunter2')),
    };
    const error = await failure(new SecretRefResolver([failing]).resolve('broken:x', ['apiKey']));
    expect(error.code).toBe('unreadable_secret');
    expect(error.message).not.toContain('hunter2');
  });
});
