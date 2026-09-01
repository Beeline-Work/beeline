import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { SqlDatabase } from './database.js';
import { bearer, type TokenAuth } from './auth.js';
import { PHONE_OPERATION_NAMES, type PhoneService } from './phone-service.js';
import { DAEMON_OPERATION_NAMES, type DaemonService } from './daemon-service.js';
import type { LiveHub } from './live.js';

export const DEFAULT_MEDIA_MAXIMUM_BYTES = 25 * 1024 * 1024;

const MAX_JSON_BYTES = 1024 * 1024;

export interface GitHubServerHooks {
  webhookSecret?: string;
  roomToken?: (identityId: string, roomId: string) => Promise<{ token: string; expiresAt: number }>;
  onWebhook?: (eventType: string, payload: unknown) => Promise<void>;
  completeInstallation?: (state: string, installationId: number) => Promise<string>;
}

export interface ServerOptions {
  database: SqlDatabase;
  auth: TokenAuth;
  phone: PhoneService;
  daemon: DaemonService;
  live: LiveHub;
  mediaMaximumBytes: number;
  github?: GitHubServerHooks;
  authHandler?: (request: IncomingMessage, response: ServerResponse) => void;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'private, no-store',
  });
  response.end(`${JSON.stringify(body)}\n`);
}

async function bytes(request: IncomingMessage, maximum: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximum) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await bytes(request, MAX_JSON_BYTES);
  if (!raw.length) return {};
  const parsed = JSON.parse(raw.toString('utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('JSON object required');
  return parsed as Record<string, unknown>;
}
function exactPath(urlValue: string | undefined): URL {
  return new URL(urlValue ?? '/', 'http://server.invalid');
}
function tokenFromProtocol(request: IncomingMessage): string | null {
  const protocol = request.headers['sec-websocket-protocol'];
  if (typeof protocol !== 'string') return null;
  const value = protocol
    .split(',')
    .map((item) => item.trim())
    .find((item) => item.startsWith('bearer.'));
  return value ? value.slice('bearer.'.length) : null;
}
function signatureMatches(secret: string, payload: Buffer, header: string | undefined) {
  if (!header?.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createBeelineServer(options: ServerOptions): Server {
  const webSockets = new WebSocketServer({ noServer: true });
  const server = createServer((request, response) => {
    const url = exactPath(request.url);
    const method = request.method ?? 'GET';
    console.log('[req]', method, url.pathname);
    void route(request, response, options).catch((error) => {
      const message = error instanceof Error ? error.message : 'request failed';
      const status =
        message.includes('required') ||
        message.includes('invalid') ||
        message.includes('too large') ||
        message.includes('size is outside')
          ? 400
          : message.includes('already linked') ||
              message.includes('already claimed') ||
              message.includes('conflict')
            ? 409
            : message.includes('access denied') || message.includes('manager')
              ? 403
              : message.includes('not found')
                ? 404
                : 503;
      console.error(
        '[req-error]',
        method,
        url.pathname,
        `status=${status}`,
        error instanceof Error ? error.stack || error.message : String(error),
      );
      json(response, status, { error: message });
    });
  });
  server.on('close', () => {
    for (const client of webSockets.clients) client.terminate();
    webSockets.close();
  });
  server.on('upgrade', (request, socket, head) => {
    void (async () => {
      const url = exactPath(request.url);
      if (url.pathname !== '/v1/phone/live') {
        socket.destroy();
        return;
      }
      const raw = tokenFromProtocol(request);
      const identityId = raw ? await options.auth.authenticatePhone(raw) : null;
      if (!identityId) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      webSockets.handleUpgrade(request, socket, head, (client) =>
        webSockets.emit('connection', client, request, identityId),
      );
    })().catch(() => socket.destroy());
  });
  webSockets.on(
    'connection',
    (client: WebSocket, _request: IncomingMessage, identityId: string) => {
      const releases = new Map<string, () => void>();
      client.on('message', (raw) => {
        void (async () => {
          let message: unknown;
          try {
            message = JSON.parse(raw.toString());
          } catch {
            return;
          }
          if (!message || typeof message !== 'object') return;
          const item = message as Record<string, unknown>;
          if (
            item.type === 'subscribe' &&
            typeof item.roomId === 'string' &&
            (await options.phone.canReadRoom(item.roomId, identityId)) &&
            !releases.has(item.roomId)
          ) {
            releases.set(
              item.roomId,
              options.live.subscribe(item.roomId, (event) => {
                if (client.readyState === client.OPEN) client.send(JSON.stringify(event));
              }),
            );
            client.send(JSON.stringify({ type: 'subscribed', roomId: item.roomId }));
          }
          if (item.type === 'unsubscribe' && typeof item.roomId === 'string') {
            releases.get(item.roomId)?.();
            releases.delete(item.roomId);
          }
        })();
      });
      client.on('close', () => {
        for (const release of releases.values()) release();
        releases.clear();
      });
    },
  );
  return server;
}

async function phoneIdentity(
  request: IncomingMessage,
  options: ServerOptions,
): Promise<string | null> {
  const value = bearer(request.headers.authorization);
  return value ? options.auth.authenticatePhone(value) : null;
}
async function daemonIdentity(
  request: IncomingMessage,
  options: ServerOptions,
): Promise<string | null> {
  const value = bearer(request.headers.authorization);
  return value ? options.auth.authenticateDaemon(value) : null;
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  options: ServerOptions,
): Promise<void> {
  const url = exactPath(request.url);
  const method = request.method ?? 'GET';
  if (
    options.authHandler &&
    (url.pathname.startsWith('/auth/') ||
      url.pathname.startsWith('/nip05/') ||
      url.pathname === '/.well-known/nostr.json')
  ) {
    options.authHandler(request, response);
    return;
  }
  if (method === 'GET' && url.pathname === '/healthz') {
    json(response, 200, { ok: true });
    return;
  }
  if (method === 'GET' && url.pathname === '/readyz') {
    await options.database.query('SELECT 1');
    json(response, 200, { ok: true });
    return;
  }
  if (method === 'GET' && url.pathname === '/version') {
    json(response, 200, {
      version: process.env.BEELINE_RELEASE_VERSION ?? 'development',
      sourceSha: process.env.BEELINE_RELEASE_SHA ?? 'unknown',
    });
    return;
  }
  if (method === 'GET' && url.pathname === '/v1/releases/daemon-readiness') {
    json(response, 200, await options.daemon.releaseReadiness());
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/auth/github/exchange') {
    const input = await body(request);
    if (typeof input.oidcToken !== 'string') throw new Error('oidcToken is required');
    json(response, 200, await options.auth.exchangeGitHubOidc(input.oidcToken));
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/auth/refresh') {
    const input = await body(request);
    if (typeof input.refreshToken !== 'string') throw new Error('refreshToken is required');
    const result = await options.auth.refresh(input.refreshToken);
    json(response, result ? 200 : 401, result ?? { error: 'stale_refresh_token' });
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/auth/daemon/exchange') {
    const input = await body(request);
    if (typeof input.exchangeToken !== 'string') throw new Error('exchangeToken is required');
    const result = await options.auth.exchangeDaemonToken(input.exchangeToken);
    json(response, result ? 200 : 401, result ?? { error: 'stale_daemon_exchange' });
    return;
  }
  if (method === 'GET' && url.pathname === '/v1/github/install/callback') {
    const state = url.searchParams.get('state');
    const installationId = Number(url.searchParams.get('installation_id'));
    if (
      !state ||
      !Number.isSafeInteger(installationId) ||
      installationId <= 0 ||
      !options.github?.completeInstallation
    )
      throw new Error('GitHub installation callback is invalid');
    const location = await options.github.completeInstallation(state, installationId);
    response.writeHead(302, { location, 'cache-control': 'no-store' });
    response.end();
    return;
  }

  if (method === 'POST' && url.pathname === '/v1/github/webhook') {
    const payload = await bytes(request, MAX_JSON_BYTES);
    if (
      !options.github?.webhookSecret ||
      !signatureMatches(
        options.github.webhookSecret,
        payload,
        request.headers['x-hub-signature-256'] as string | undefined,
      )
    ) {
      json(response, 401, { error: 'invalid_webhook_signature' });
      return;
    }
    const delivery = request.headers['x-github-delivery'];
    const event = request.headers['x-github-event'];
    if (typeof delivery !== 'string' || typeof event !== 'string')
      throw new Error('GitHub delivery headers are required');
    const parsed = JSON.parse(payload.toString('utf8')) as unknown;
    const inserted = await options.database.query(
      `INSERT INTO github_webhook_deliveries(delivery_id,event_type,payload) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING`,
      [delivery, event, JSON.stringify(parsed)],
    );
    if (inserted.rowCount && options.github.onWebhook)
      await options.github.onWebhook(event, parsed);
    json(response, inserted.rowCount ? 202 : 200, {
      accepted: Boolean(inserted.rowCount),
      duplicate: !inserted.rowCount,
    });
    return;
  }

  const identityId = await phoneIdentity(request, options);
  if (method === 'GET' && url.pathname.startsWith('/v1/media/')) {
    const mediaId = url.pathname.slice('/v1/media/'.length);
    const media = (
      await options.database.query<{ bytes: Uint8Array; mime_type: string; name: string }>(
        `SELECT bytes,mime_type,name FROM media WHERE id=$1`,
        [mediaId],
      )
    ).rows[0];
    if (!media) {
      json(response, 404, { error: 'media_not_found' });
      return;
    }
    response.writeHead(200, {
      'content-type': media.mime_type,
      'content-length': String(media.bytes.length),
      'cache-control': 'public, max-age=31536000, immutable',
      'content-disposition': `inline; filename="${media.name.replaceAll('"', '')}"`,
    });
    response.end(Buffer.from(media.bytes));
    return;
  }
  if (url.pathname.startsWith('/v1/phone/') && !identityId) {
    json(response, 401, { error: 'phone_token_required' });
    return;
  }

  if (method === 'GET' && url.pathname === '/v1/phone/workspaces') {
    json(response, 200, await options.phone.readWorkspaces(identityId!));
    return;
  }
  let match = url.pathname.match(/^\/v1\/phone\/workspaces\/([0-9a-f-]+)$/);
  if (method === 'GET' && match) {
    const result = await options.phone.readWorkspace(match[1]!, identityId!);
    json(response, result ? 200 : 404, result ?? { error: 'not_found' });
    return;
  }
  match = url.pathname.match(/^\/v1\/phone\/workspaces\/([0-9a-f-]+)\/chats$/);
  if (method === 'GET' && match) {
    const result = await options.phone.readChats(match[1]!, identityId!);
    json(response, result ? 200 : 404, result ?? { error: 'not_found' });
    return;
  }
  match = url.pathname.match(/^\/v1\/phone\/workspaces\/([0-9a-f-]+)\/agents\/([0-9a-f]{64})$/);
  if (method === 'GET' && match) {
    const result = await options.phone.readAgent(match[1]!, match[2]!, identityId!);
    json(response, result ? 200 : 404, result ?? { error: 'not_found' });
    return;
  }
  match = url.pathname.match(/^\/v1\/phone\/rooms\/([0-9a-f-]+)$/);
  if (method === 'GET' && match) {
    const result = await options.phone.readRoom(match[1]!, identityId!);
    json(response, result ? 200 : 404, result ?? { error: 'not_found' });
    return;
  }
  match = url.pathname.match(/^\/v1\/phone\/rooms\/([0-9a-f-]+)\/history$/);
  if (method === 'GET' && match) {
    const beforeRaw = url.searchParams.get('before');
    const parsed = beforeRaw?.match(/^(\d+),([0-9a-f]{64})$/);
    const result = await options.phone.readHistory(
      match[1]!,
      identityId!,
      parsed ? { createdAt: Number(parsed[1]), id: parsed[2]! } : undefined,
    );
    json(response, result ? 200 : 404, result ?? { error: 'not_found' });
    return;
  }
  match = url.pathname.match(/^\/v1\/phone\/rooms\/([0-9a-f-]+)\/corners$/);
  if (method === 'GET' && match) {
    const result = await options.phone.readCorners(match[1]!, identityId!);
    json(response, result ? 200 : 404, result ?? { error: 'not_found' });
    return;
  }
  match = url.pathname.match(/^\/v1\/phone\/rooms\/([0-9a-f-]+)\/read$/);
  if (method === 'POST' && match) {
    const input = await body(request);
    if (typeof input.messageId !== 'string') throw new Error('messageId is required');
    await options.phone.markRead(match[1]!, input.messageId, identityId!);
    json(response, 204, {});
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/phone/media') {
    const raw = await bytes(request, options.mediaMaximumBytes + 1);
    const mime =
      typeof request.headers['content-type'] === 'string'
        ? request.headers['content-type']
        : 'application/octet-stream';
    const name =
      typeof request.headers['x-file-name'] === 'string'
        ? request.headers['x-file-name']
        : 'upload';
    json(
      response,
      201,
      await options.phone.uploadMedia(identityId!, raw, mime, name, options.mediaMaximumBytes),
    );
    return;
  }
  match = url.pathname.match(/^\/v1\/phone\/github\/room-token\/([0-9a-f-]+)$/);
  if (method === 'GET' && match) {
    if (!options.github?.roomToken) throw new Error('GitHub room token service unavailable');
    if (!(await options.phone.canReadRoom(match[1]!, identityId!))) {
      json(response, 403, { error: 'room_access_denied' });
      return;
    }
    json(response, 200, await options.github.roomToken(identityId!, match[1]!));
    return;
  }
  match = url.pathname.match(/^\/v1\/phone\/operations\/([A-Za-z][A-Za-z0-9]+)$/);
  if (method === 'POST' && match) {
    const name = match[1]!;
    console.log('[phone-op]', name, `identity=${identityId}`, 'start');
    if (!PHONE_OPERATION_NAMES.has(name as never)) {
      json(response, 404, { error: 'unknown_phone_operation' });
      return;
    }
    const input = await body(request);
    const result = await options.phone.execute(name as never, input as never, identityId!);
    console.log('[phone-op]', name, `identity=${identityId}`, 'ok');
    if (typeof input.roomId === 'string')
      options.live.publish({ type: 'invalidate', roomId: input.roomId, reason: 'phone-write' });
    if (result === undefined) {
      response.writeHead(204, { 'cache-control': 'private, no-store' });
      response.end();
      return;
    }
    json(response, 200, result);
    return;
  }

  match = url.pathname.match(/^\/v1\/daemon\/operations\/([A-Za-z][A-Za-z0-9]+)$/);
  if (method === 'POST' && match) {
    const agentId = await daemonIdentity(request, options);
    if (!agentId) {
      json(response, 401, { error: 'daemon_token_required' });
      return;
    }
    const name = match[1]!;
    if (!DAEMON_OPERATION_NAMES.has(name as never)) {
      json(response, 404, { error: 'unknown_daemon_operation' });
      return;
    }
    json(
      response,
      200,
      await options.daemon.execute(name as never, (await body(request)) as never, agentId),
    );
    return;
  }
  json(response, 404, { error: 'not_found' });
}
