import { nip98AuthHeader } from '@beeline/nostr';
import type { Identity } from './types.js';

export class OidcBindError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    /** Machine-readable extras from typed service errors (e.g. install URLs). */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'OidcBindError';
  }

  get retryable(): boolean {
    return this.code === 'offline' || (this.status !== undefined && this.status >= 500);
  }
}

export function authEndpoint(baseUrl: string, path: string): URL {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' && base.protocol !== 'http:') {
    throw new OidcBindError('invalid_configuration', 'auth base URL must use HTTP or HTTPS');
  }
  if (base.username || base.password || base.search || base.hash) {
    throw new OidcBindError('invalid_configuration', 'auth base URL must be an origin');
  }
  return new URL(path, `${base.origin}/`);
}

interface AuthJsonRequestOptions {
  method?: 'GET' | 'POST';
  identity?: Pick<Identity, 'secretKey' | 'publicKey'>;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface AuthJsonResponse {
  body: Record<string, unknown>;
  status: number;
}

async function responseBody(response: Response): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new OidcBindError(
      'invalid_response',
      'auth service returned an invalid response',
      response.status,
    );
  }
  return body as Record<string, unknown>;
}

function serviceError(body: Record<string, unknown>, status: number): OidcBindError {
  const code = typeof body.error === 'string' ? body.error : 'auth_service_error';
  const message =
    typeof body.message === 'string' ? body.message : `auth service returned HTTP ${status}`;
  // Typed error bodies may carry actionable extras (e.g. owner_grant_needed's
  // shareable install URL); pass through the known fields only.
  const details: Record<string, unknown> = {};
  if (typeof body.install_url === 'string') details.installUrl = body.install_url;
  if (typeof body.repository === 'string') details.repository = body.repository;
  return new OidcBindError(
    code,
    message,
    status,
    Object.keys(details).length > 0 ? details : undefined,
  );
}

/**
 * Execute one auth-service JSON request. Route modules retain request construction
 * and response validation; this helper owns only transport and shared error behavior.
 */
export async function requestAuthJson(
  baseUrl: string,
  path: string | URL,
  options: AuthJsonRequestOptions = {},
): Promise<AuthJsonResponse> {
  const url = typeof path === 'string' ? authEndpoint(baseUrl, path) : path;
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { ...options.headers };
  if (options.identity) {
    headers.authorization = nip98AuthHeader(
      options.identity.secretKey,
      options.identity.publicKey,
      url.toString(),
      method,
    );
  }
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      ...(method === 'GET' ? {} : { method }),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    throw new OidcBindError(
      'offline',
      error instanceof Error ? error.message : 'auth service unavailable',
    );
  }

  const body = await responseBody(response);
  if (!response.ok) throw serviceError(body, response.status);
  return { body, status: response.status };
}
