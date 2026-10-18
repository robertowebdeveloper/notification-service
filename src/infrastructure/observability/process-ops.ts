import type { AppConfig } from '../../config/env.js';
import {
  startOpsServer,
  type MetricsSource,
  type OpsServer,
  type OpsServerLogger,
  type ReadinessFn,
} from './ops-server.js';

export class OpsServerStartError extends Error {
  constructor(
    readonly host: string,
    readonly port: number,
    readonly code: string | undefined,
    cause: unknown,
  ) {
    const reason =
      code === 'EADDRINUSE'
        ? 'address already in use (set OPS_PORT to a free port: each process on a host needs its own)'
        : code === 'EACCES'
          ? 'permission denied'
          : cause instanceof Error
            ? cause.message
            : String(cause);
    super(`ops server cannot listen on ${host}:${port}: ${reason}`, { cause });
    this.name = 'OpsServerStartError';
  }
}

/** A readiness function from named boolean checks; a throwing check counts as not ready. */
export function dependencyReadiness(checks: Record<string, () => Promise<boolean>>): ReadinessFn {
  return async () => {
    const entries = await Promise.all(
      Object.entries(checks).map(async ([name, check]) => {
        try {
          return [name, await check()] as const;
        } catch {
          return [name, false] as const;
        }
      }),
    );
    const result = Object.fromEntries(entries);
    return { ready: entries.every(([, ok]) => ok), checks: result };
  };
}

export interface ProcessOpsOptions {
  config: Pick<AppConfig, 'OPS_HOST' | 'OPS_PORT'>;
  metrics: MetricsSource;
  readiness?: ReadinessFn;
  logger: OpsServerLogger;
}

/** Starts the internal ops server on `OPS_HOST:OPS_PORT`; listen errors become a clear error. */
export async function startProcessOps(options: ProcessOpsOptions): Promise<OpsServer> {
  const { OPS_HOST: host, OPS_PORT: port } = options.config;
  try {
    return await startOpsServer({
      host,
      port,
      metrics: options.metrics,
      ...(options.readiness === undefined ? {} : { readiness: options.readiness }),
      logger: options.logger,
    });
  } catch (error) {
    throw new OpsServerStartError(host, port, (error as { code?: string }).code, error);
  }
}
