import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/env.js';
import { httpServerSettingsOf } from '../../../src/config/runtime-settings.js';
import { buildApp, DOCS_PATH, OPENAPI_JSON_PATH } from '../../../src/http/app.js';
import { buildTestApi } from './support/fakes.js';

const BASE_ENV = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  VALKEY_URL: 'redis://localhost:6379',
};

function readiness() {
  return Promise.resolve({ ready: true, checks: {} });
}

describe('API documentation', () => {
  it('serves the Swagger UI only when enabled', async () => {
    const enabled = await buildApp({ logger: false, readiness, http: { docs: true } });
    const page = await enabled.inject({ url: DOCS_PATH });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    expect(page.headers['content-security-policy']).toBeDefined();

    const disabled = await buildApp({ logger: false, readiness });
    expect((await disabled.inject({ url: DOCS_PATH })).statusCode).toBe(404);
    expect((await disabled.inject({ url: OPENAPI_JSON_PATH })).statusCode).toBe(200);
  });

  it('enables the UI by default in local and test only', () => {
    const docs = (env: Record<string, string>) =>
      httpServerSettingsOf(loadConfig({ ...BASE_ENV, ...env })).docs;
    expect(docs({ APP_ENV: 'local' })).toBe(true);
    expect(docs({ APP_ENV: 'local', API_DOCS_ENABLED: 'false' })).toBe(false);
  });

  it('documents resource ids as positive integers', async () => {
    const api = await buildTestApi();
    const spec = (await api.app.inject({ url: OPENAPI_JSON_PATH })).json<{
      paths: Record<string, Record<string, { parameters?: { name: string; schema: unknown }[] }>>;
    }>();
    const read = spec.paths['/v1/notifications/{id}']?.get;
    expect(read?.parameters?.find((p) => p.name === 'id')?.schema).toMatchObject({
      type: 'string',
      pattern: '^[1-9][0-9]{0,15}$',
    });
  });
});
