import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Same shape as the public API's `/health/ready` body. */
export interface ReadinessResult {
  ready: boolean;
  checks: Record<string, boolean>;
}

export type ReadinessFn = () => Promise<ReadinessResult>;

export interface OpsServerLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

export interface MetricsSource {
  readonly contentType: string;
  scrape(): Promise<string>;
}

export interface OpsServerOptions {
  host: string;
  /** 0 picks a free port (tests). */
  port: number;
  /** `GET /metrics`; 404 when omitted. */
  metrics?: MetricsSource;
  /** `GET /health/ready`; 404 when omitted (the API keeps its health on the public port). */
  readiness?: ReadinessFn;
  /** A readiness call slower than this answers 503 (default 5000 ms). */
  readinessTimeoutMs?: number;
  logger?: OpsServerLogger;
}

export interface OpsServer {
  readonly address: AddressInfo;
  /** Stops accepting connections and resolves once in-flight requests completed. */
  close(): Promise<void>;
}

const NOT_READY: ReadinessResult = { ready: false, checks: {} };

/**
 * Internal operations server (`node:http`, no framework): `/metrics`, `/health/live`,
 * `/health/ready`. Bound to `OPS_HOST:OPS_PORT`, never routed through the ingress. Requests are
 * not logged above debug.
 */
export async function startOpsServer(options: OpsServerOptions): Promise<OpsServer> {
  const timeoutMs = options.readinessTimeoutMs ?? 5_000;
  const logger = options.logger;

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      logger?.warn({ err: errorMessage(error), path: pathOf(request) }, 'ops request failed');
      if (!response.headersSent) send(response, 500, 'text/plain; charset=utf-8', 'error\n');
      else response.destroy();
    });
  });
  server.keepAliveTimeout = 5_000;

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = pathOf(request);
    logger?.debug({ method: request.method, path }, 'ops request');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(response, 404, 'text/plain; charset=utf-8', 'not found\n');
      return;
    }
    if (path === '/metrics' && options.metrics !== undefined) {
      const body = await options.metrics.scrape();
      send(response, 200, options.metrics.contentType, body);
      return;
    }
    if (path === '/health/live') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }
    if (path === '/health/ready' && options.readiness !== undefined) {
      const result = await readinessWithin(options.readiness, timeoutMs, logger);
      sendJson(response, result.ready ? 200 : 503, result);
      return;
    }
    send(response, 404, 'text/plain; charset=utf-8', 'not found\n');
  }

  server.listen(options.port, options.host);
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  let closing: Promise<void> | undefined;
  return {
    address,
    close: () => {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeIdleConnections();
      });
      return closing;
    },
  };
}

async function readinessWithin(
  readiness: ReadinessFn,
  timeoutMs: number,
  logger: OpsServerLogger | undefined,
): Promise<ReadinessResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<ReadinessResult>((resolve) => {
    timer = setTimeout(() => {
      logger?.warn({ timeoutMs }, 'readiness check timed out');
      resolve(NOT_READY);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      readiness().catch((error: unknown) => {
        logger?.warn({ err: errorMessage(error) }, 'readiness check failed');
        return NOT_READY;
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function pathOf(request: IncomingMessage): string {
  const url = request.url ?? '/';
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

function send(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(response.req.method === 'HEAD' ? undefined : body);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  send(response, status, 'application/json; charset=utf-8', JSON.stringify(body));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
