import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Local HTTP double of the Resend API on an ephemeral loopback port. Behaviour of
 * POST /emails is selected by the recipient local part; GET /emails/:id reads `statuses`.
 */
export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export interface FakeResendServer {
  baseUrl: string;
  requests: RecordedRequest[];
  statuses: Map<string, Record<string, unknown>>;
  close(): Promise<void>;
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function recipientLocalPart(body: unknown): string {
  const to = (body as { to?: unknown } | null)?.to;
  const first = Array.isArray(to) ? (to[0] as unknown) : to;
  return typeof first === 'string' ? (first.split('@')[0] ?? '') : '';
}

export async function startFakeResendServer(): Promise<FakeResendServer> {
  const requests: RecordedRequest[] = [];
  const statuses = new Map<string, Record<string, unknown>>();
  const idsByKey = new Map<string, string>();
  let sequence = 0;

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const body: unknown = text === '' ? undefined : JSON.parse(text);
      const method = req.method ?? 'GET';
      const url = req.url ?? '/';
      requests.push({ method, url, headers: req.headers, body });

      if (method === 'GET' && url.startsWith('/emails/')) {
        const id = decodeURIComponent(url.slice('/emails/'.length));
        const status = statuses.get(id);
        if (status === undefined) {
          json(res, 404, { statusCode: 404, name: 'not_found', message: 'Email not found' });
          return;
        }
        json(res, 200, { object: 'email', id, ...status });
        return;
      }
      if (method !== 'POST' || url !== '/emails') {
        json(res, 404, { statusCode: 404, name: 'not_found', message: 'Not found' });
        return;
      }

      switch (recipientLocalPart(body)) {
        case 'hang':
          return; // never respond
        case 'reject-permanent':
        case 'http-422':
          json(res, 422, {
            statusCode: 422,
            name: 'validation_error',
            message: 'Invalid `to` field',
          });
          return;
        case 'http-400':
          json(res, 400, { statusCode: 400, name: 'validation_error', message: 'Bad request' });
          return;
        case 'reject-retryable':
        case 'http-429':
          json(
            res,
            429,
            { statusCode: 429, name: 'rate_limit_exceeded', message: 'Too many requests' },
            { 'retry-after': '7' },
          );
          return;
        case 'http-401':
          json(res, 401, { statusCode: 401, name: 'missing_api_key', message: 'Missing API key' });
          return;
        case 'http-403':
          json(res, 403, {
            statusCode: 403,
            name: 'invalid_api_key',
            message: 'API key is invalid',
          });
          return;
        case 'http-409-concurrent':
          json(res, 409, {
            statusCode: 409,
            name: 'concurrent_idempotent_requests',
            message: 'In progress',
          });
          return;
        case 'http-409-mismatch':
          json(res, 409, {
            statusCode: 409,
            name: 'invalid_idempotent_request',
            message: 'Payload mismatch',
          });
          return;
        case 'http-500':
          json(res, 500, {
            statusCode: 500,
            name: 'internal_server_error',
            message: 'Unexpected error',
          });
          return;
        case 'no-id':
          json(res, 200, { ok: true });
          return;
        case 'reset':
          req.socket.destroy();
          return;
        default: {
          const key = req.headers['idempotency-key'];
          const idempotencyKey = Array.isArray(key) ? key[0] : key;
          let id = idempotencyKey === undefined ? undefined : idsByKey.get(idempotencyKey);
          if (id === undefined) {
            sequence += 1;
            id = `re_${sequence}`;
            if (idempotencyKey !== undefined) idsByKey.set(idempotencyKey, id);
          }
          json(res, 200, { id });
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    statuses,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
