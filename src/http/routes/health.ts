import type { FastifyPluginAsync } from 'fastify';

export type ReadinessCheck = () => Promise<{ ready: boolean; checks: Record<string, boolean> }>;

export const healthRoutes: FastifyPluginAsync<{ readiness: ReadinessCheck }> = async (
  app,
  opts,
) => {
  app.get('/health/live', { schema: { hide: true }, logLevel: 'warn' }, () => ({ status: 'ok' }));
  app.get(
    '/health/ready',
    { schema: { hide: true }, logLevel: 'warn' },
    async (_request, reply) => {
      const result = await opts.readiness();
      return reply.status(result.ready ? 200 : 503).send(result);
    },
  );
  return Promise.resolve();
};
