import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';

describe('health routes', () => {
  it('reports liveness without dependencies', async () => {
    const app = await buildApp({
      logger: false,
      readiness: () => Promise.resolve({ ready: false, checks: {} }),
    });
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
  });

  it('returns 503 when a required dependency is unavailable', async () => {
    const app = await buildApp({
      logger: false,
      readiness: () => Promise.resolve({ ready: false, checks: { database: false } }),
    });
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ready: false, checks: { database: false } });
  });

  it('returns uniform error body for unknown routes', async () => {
    const app = await buildApp({
      logger: false,
      readiness: () => Promise.resolve({ ready: true, checks: {} }),
    });
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    const body = res.json<{ code: string; requestId: string }>();
    expect(body.code).toBe('not_found');
    expect(body.requestId).not.toBe('');
  });
});
