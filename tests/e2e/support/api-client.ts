import { randomUUID } from 'node:crypto';
import { ROUTES } from '../../../src/contracts/http-schemas.js';
import type {
  CreateNotificationResponse,
  ErrorBody,
  NotificationView,
} from '../../../src/contracts/http-schemas.js';

export interface ApiResponse<T = unknown> {
  status: number;
  headers: Headers;
  body: T;
}

export interface RequestOptions {
  apiKey?: string;
  idempotencyKey?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

function path(template: string, id: number): string {
  return template.replace(':id', encodeURIComponent(id));
}

/** Thin HTTP client for the public API under /v1 (black-box: real HTTP to the API process). */
export class ApiClient {
  constructor(readonly baseUrl: string) {}

  async request<T = unknown>(
    method: string,
    route: string,
    options: RequestOptions = {},
  ): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.apiKey !== undefined) headers.authorization = `Bearer ${options.apiKey}`;
    if (options.idempotencyKey !== undefined) headers['idempotency-key'] = options.idempotencyKey;
    let payload: string | undefined;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(options.body);
    }
    const response = await fetch(`${this.baseUrl}${route}`, {
      method,
      headers,
      ...(payload === undefined ? {} : { body: payload }),
    });
    const text = await response.text();
    let body: unknown = text;
    if (text !== '') {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }
    return { status: response.status, headers: response.headers, body: body as T };
  }

  createNotification(apiKey: string, idempotencyKey: string, body: unknown) {
    return this.request<CreateNotificationResponse & Partial<ErrorBody>>(
      'POST',
      ROUTES.notifications,
      { apiKey, idempotencyKey, body },
    );
  }

  getNotification(apiKey: string, id: number) {
    return this.request<NotificationView & Partial<ErrorBody>>(
      'GET',
      path(ROUTES.notificationById, id),
      { apiKey },
    );
  }

  listNotifications(apiKey: string, query: Record<string, string> = {}) {
    const search = new URLSearchParams(query).toString();
    return this.request('GET', `${ROUTES.notifications}${search === '' ? '' : `?${search}`}`, {
      apiKey,
    });
  }

  retryNotification(apiKey: string, id: number, idempotencyKey: string = randomUUID()) {
    return this.request<Partial<ErrorBody> & Record<string, unknown>>(
      'POST',
      path(ROUTES.notificationRetry, id),
      { apiKey, idempotencyKey },
    );
  }

  /** Raw webhook delivery: the body must be sent byte-for-byte as signed. */
  async postWebhook(
    providerType: string,
    instanceId: number,
    rawBody: string,
    headers: Record<string, string>,
  ): Promise<ApiResponse> {
    const route = ROUTES.providerWebhook
      .replace(':providerType', encodeURIComponent(providerType))
      .replace(':instanceId', encodeURIComponent(instanceId));
    const response = await fetch(`${this.baseUrl}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: rawBody,
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = text === '' ? undefined : (JSON.parse(text) as unknown);
    } catch {
      body = text;
    }
    return { status: response.status, headers: response.headers, body };
  }
}

/**
 * Extracts the page items of a list response. The list response envelope is not frozen in
 * `src/contracts/http-schemas.ts`; accepted shapes: `{ items }`, `{ data }`, `{ notifications }`
 * or a bare array. Returns undefined for anything else so the assertion fails visibly.
 */
export function listItems(body: unknown): { id: number }[] | undefined {
  if (Array.isArray(body)) return body as { id: number }[];
  if (typeof body !== 'object' || body === null) return undefined;
  const record = body as Record<string, unknown>;
  for (const key of ['items', 'data', 'notifications']) {
    const value = record[key];
    if (Array.isArray(value)) return value as { id: number }[];
  }
  return undefined;
}
