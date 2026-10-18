import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Controllable Resend API double (loopback HTTP). Like the real API it is idempotent on the
 * `Idempotency-Key` header: the same key always yields the same email id, and a concurrent request
 * with a key whose first request is still in flight gets 409 `concurrent_idempotent_requests`.
 *
 * Behaviours are programmed per recipient and consumed one POST /emails at a time (last repeats):
 * accept, hold (answers 200 only on `release()`), hang (never answers), reset (drops the socket),
 * or an explicit HTTP error status with optional Retry-After.
 */
export type ResendBehaviour =
  | { kind: 'accept' }
  | { kind: 'hold' }
  | { kind: 'hang' }
  | { kind: 'reset' }
  | { kind: 'error'; status: number; name: string; retryAfterSeconds?: number };

export const resendBehaviours = {
  accept: { kind: 'accept' },
  hold: { kind: 'hold' },
  hang: { kind: 'hang' },
  reset: { kind: 'reset' },
  rateLimited: (retryAfterSeconds: number): ResendBehaviour => ({
    kind: 'error',
    status: 429,
    name: 'rate_limit_exceeded',
    retryAfterSeconds,
  }),
  invalidRecipient: { kind: 'error', status: 422, name: 'validation_error' },
  serverError: { kind: 'error', status: 500, name: 'internal_server_error' },
} as const satisfies Record<string, ResendBehaviour | ((n: number) => ResendBehaviour)>;

export interface ResendRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: unknown;
  receivedAt: Date;
  recipient: string | undefined;
  idempotencyKey: string | undefined;
  behaviour: ResendBehaviour | undefined;
  /** Email id assigned (accept/hold), known before the response is sent. */
  emailId: string | undefined;
  /** HTTP status sent, undefined while held/hanging. */
  responseStatus: number | undefined;
}

export interface FakeResendServer {
  readonly baseUrl: string;
  readonly requests: readonly ResendRequest[];
  program(recipient: string, behaviours: ResendBehaviour[]): void;
  sends(recipient: string): ResendRequest[];
  /** Distinct idempotency keys used for the recipient (distinct logical sends). */
  idempotencyKeys(recipient: string): string[];
  release(recipient: string): number;
  releaseAll(): void;
  close(): Promise<void>;
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function firstRecipient(body: unknown): string | undefined {
  const to = (body as { to?: unknown } | null)?.to;
  const first: unknown = Array.isArray(to) ? to[0] : to;
  return typeof first === 'string' ? first.toLowerCase() : undefined;
}

function json(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
) {
  res.writeHead(status, { 'content-type': 'application/json', ...extra });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function startFakeResendServer(): Promise<FakeResendServer> {
  const programs = new Map<string, ResendBehaviour[]>();
  const requests: ResendRequest[] = [];
  const idsByKey = new Map<string, string>();
  const inFlightKeys = new Set<string>();
  const knownIds = new Set<string>();
  const held = new Map<string, (() => void)[]>();

  const next = (recipient: string | undefined): ResendBehaviour => {
    const queue = recipient === undefined ? undefined : programs.get(recipient);
    if (queue === undefined || queue.length === 0) return resendBehaviours.accept;
    return queue.length > 1
      ? (queue.shift() ?? resendBehaviours.accept)
      : (queue[0] ?? resendBehaviours.accept);
  };

  const emailIdFor = (key: string | undefined): string => {
    if (key === undefined) return `re_e2e_${randomUUID()}`;
    let id = idsByKey.get(key);
    if (id === undefined) {
      id = `re_e2e_${randomUUID()}`;
      idsByKey.set(key, id);
    }
    return id;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';

    if (method === 'GET' && url.startsWith('/emails/')) {
      const id = decodeURIComponent(url.slice('/emails/'.length));
      if (!knownIds.has(id)) {
        json(res, 404, { statusCode: 404, name: 'not_found', message: 'Email not found' });
        return;
      }
      json(res, 200, { object: 'email', id, last_event: 'sent' });
      return;
    }
    if (method !== 'POST' || url !== '/emails') {
      json(res, 404, { statusCode: 404, name: 'not_found', message: 'Not found' });
      return;
    }

    const recipient = firstRecipient(body);
    const idempotencyKey = header(req.headers, 'idempotency-key');
    const record: ResendRequest = {
      method,
      url,
      headers: req.headers,
      body,
      receivedAt: new Date(),
      recipient,
      idempotencyKey,
      behaviour: undefined,
      emailId: undefined,
      responseStatus: undefined,
    };
    requests.push(record);

    if (idempotencyKey !== undefined && inFlightKeys.has(idempotencyKey)) {
      record.responseStatus = 409;
      json(res, 409, {
        statusCode: 409,
        name: 'concurrent_idempotent_requests',
        message: 'Another request with this idempotency key is in progress',
      });
      return;
    }

    const behaviour = next(recipient);
    record.behaviour = behaviour;
    switch (behaviour.kind) {
      case 'hang':
        return;
      case 'reset':
        req.socket.destroy();
        return;
      case 'error': {
        record.responseStatus = behaviour.status;
        const extra: Record<string, string> =
          behaviour.retryAfterSeconds === undefined
            ? {}
            : { 'retry-after': String(behaviour.retryAfterSeconds) };
        json(
          res,
          behaviour.status,
          { statusCode: behaviour.status, name: behaviour.name, message: behaviour.name },
          extra,
        );
        return;
      }
      case 'hold': {
        const id = emailIdFor(idempotencyKey);
        record.emailId = id;
        knownIds.add(id);
        if (idempotencyKey !== undefined) inFlightKeys.add(idempotencyKey);
        const list = held.get(recipient ?? '') ?? [];
        list.push(() => {
          if (idempotencyKey !== undefined) inFlightKeys.delete(idempotencyKey);
          record.responseStatus = 200;
          if (!res.destroyed) json(res, 200, { id });
        });
        held.set(recipient ?? '', list);
        // A dead client must not keep the key "in flight" forever.
        res.once('close', () => {
          if (record.responseStatus === undefined && idempotencyKey !== undefined) {
            inFlightKeys.delete(idempotencyKey);
          }
        });
        return;
      }
      case 'accept': {
        const id = emailIdFor(idempotencyKey);
        record.emailId = id;
        knownIds.add(id);
        record.responseStatus = 200;
        json(res, 200, { id });
      }
    }
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { name: 'fake_failure' });
    });
  });
  server.keepAliveTimeout = 1_000;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const sends = (recipient: string) =>
    requests.filter((r) => r.recipient === recipient.toLowerCase());
  const release = (recipient: string): number => {
    const list = held.get(recipient.toLowerCase()) ?? [];
    held.delete(recipient.toLowerCase());
    for (const reply of list) reply();
    return list.length;
  };

  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    requests,
    program(recipient, behaviours) {
      programs.set(recipient.toLowerCase(), [...behaviours]);
    },
    sends,
    idempotencyKeys: (recipient) => [
      ...new Set(
        sends(recipient)
          .map((r) => r.idempotencyKey)
          .filter((k): k is string => k !== undefined),
      ),
    ],
    release,
    releaseAll() {
      for (const recipient of [...held.keys()]) release(recipient);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
