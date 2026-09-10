import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { SqlDatabase } from './database.js';
import { bearer, type TokenAuth } from './auth.js';
import {
  AGENT_OWNER_AUTHORITY_MESSAGE,
  TURN_REQUESTER_AUTHORITY_MESSAGE,
  PHONE_OPERATION_NAMES,
  YOLO_AUTHORITY_MESSAGE,
  type PhoneService,
} from './phone-service.js';
import { DAEMON_OPERATION_NAMES, type DaemonService } from './daemon-service.js';
import type { LiveEvent, LiveHub, LiveTrace } from './live.js';
import type { ReviewAccess } from './review-access.js';
import type { ReleaseNotifier } from './release-notify.js';
import { isMediaId, mediaTtlHours } from './media-ttl.js';
import { InvitePreviewAccess } from './invite-preview.js';
import type { ConnectionPresence } from './connection-presence.js';

export const DEFAULT_MEDIA_MAXIMUM_BYTES = 25 * 1024 * 1024;

const MAX_JSON_BYTES = 1024 * 1024;
const LIVE_DELTA_DEADLINE_MS = 400;

async function withinLiveDeltaDeadline<T>(work: Promise<T>): Promise<T> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error('committed row delivery deadline exceeded')),
          LIVE_DELTA_DEADLINE_MS,
        );
        deadline.unref?.();
      }),
    ]);
  } finally {
    if (deadline) clearTimeout(deadline);
  }
}

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
  connectionPresence?: ConnectionPresence;
  mediaMaximumBytes: number;
  github?: GitHubServerHooks;
  /** Absent when no review secret is configured; the endpoint then refuses like any wrong secret. */
  review?: ReviewAccess;
  /** Absent when no release-notify secret is configured; the endpoint then refuses like any wrong secret. */
  releaseNotify?: ReleaseNotifier;
  /** Diagnostics only: one DB-clock read after an authorized cross-process
   * delta is painted. Ordinary live delivery performs no extra query. */
  livePaintDiagnostics?: boolean;
  authHandler?: (request: IncomingMessage, response: ServerResponse) => void;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'private, no-store',
  });
  response.end(`${JSON.stringify(body)}\n`);
}

function publicJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'x-content-type-options': 'nosniff',
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
function isInboxCursor(value: unknown): value is string {
  return typeof value === 'string' && /^\d+,[0-9a-f]{64}$/.test(value);
}
/** Who a rate limit counts against: the edge's client address, else the socket peer. */
function clientKey(request: IncomingMessage): string {
  const forwarded = request.headers['fly-client-ip'] ?? request.headers['x-forwarded-for'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = value?.split(',')[0]?.trim();
  return first || request.socket.remoteAddress || 'unknown';
}
function signatureMatches(secret: string, payload: Buffer, header: string | undefined) {
  if (!header?.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}
/** Constant time over fixed-width digests, so neither the secret nor its length leaks. */
function bearerSecretMatches(secret: string, request: IncomingMessage): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(header.slice('Bearer '.length)), digest(secret));
}

export function createBeelineServer(options: ServerOptions): Server {
  const webSockets = new WebSocketServer({ noServer: true });
  const invitePreview = new InvitePreviewAccess(options.database);
  const server = createServer((request, response) => {
    const url = exactPath(request.url);
    const method = request.method ?? 'GET';
    console.log('[req]', method, url.pathname);
    void route(request, response, options, invitePreview).catch((error) => {
      const message = error instanceof Error ? error.message : 'request failed';
      const status =
        message.includes('required') ||
        message.includes('invalid') ||
        message.includes('too large') ||
        message.includes('size is outside')
          ? 400
          : message.includes('already linked') ||
              message.includes('already claimed') ||
              message.includes('conflict') ||
              message.includes('checks are failing')
            ? 409
            : message.includes('access denied') ||
                message.includes('command output authority rejected') ||
                message.includes('command turn cancelled') ||
                message.includes('command already completed') ||
                message.includes('manager') ||
                message.includes(AGENT_OWNER_AUTHORITY_MESSAGE) ||
                message.includes(TURN_REQUESTER_AUTHORITY_MESSAGE) ||
                message.includes('yolo cannot be enabled in a public workspace') ||
                message.includes(YOLO_AUTHORITY_MESSAGE)
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
      // Daemon tokens have a distinct prefix. Avoid making every phone socket
      // pay for a failed daemon-auth query before its ordinary session lookup.
      const daemonId = raw?.startsWith('bdt_') ? await options.auth.authenticateDaemon(raw) : null;
      const phoneId =
        raw && !raw.startsWith('bdt_') ? await options.auth.authenticatePhone(raw) : null;
      const identityId = daemonId ?? phoneId;
      if (!identityId) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      webSockets.handleUpgrade(request, socket, head, (client) =>
        webSockets.emit('connection', client, request, {
          identityId,
          kind: daemonId ? 'daemon' : 'phone',
        }),
      );
    })().catch(() => socket.destroy());
  });
  webSockets.on(
    'connection',
    (
      client: WebSocket,
      _request: IncomingMessage,
      principal: { identityId: string; kind: 'phone' | 'daemon' },
    ) => {
      const releases = new Map<string, () => void>();
      const pendingPaintTraces = new Map<
        string,
        {
          readonly startedAt?: number;
          readonly databaseAt: number;
          readonly databaseClock: boolean;
        }
      >();
      const rememberPaintTrace = (trace: LiveTrace | undefined) => {
        if (!trace || (typeof trace.startedAt !== 'number' && trace.paintAck !== 'database-clock'))
          return;
        pendingPaintTraces.set(trace.id, {
          startedAt: trace.startedAt,
          databaseAt: trace.databaseAt,
          databaseClock: trace.paintAck === 'database-clock',
        });
        if (pendingPaintTraces.size > 64) {
          const oldest = pendingPaintTraces.keys().next().value;
          if (oldest) pendingPaintTraces.delete(oldest);
        }
      };
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
          if (item.type === 'trace-paint' && typeof item.id === 'string') {
            const trace = pendingPaintTraces.get(item.id);
            if (!trace || client.readyState !== client.OPEN) return;
            pendingPaintTraces.delete(item.id);
            if (trace.databaseClock) {
              const clock = (
                await options.database.query<{ clock_at: Date }>(
                  `SELECT clock_timestamp() clock_at`,
                )
              ).rows[0]?.clock_at;
              if (!clock || client.readyState !== client.OPEN) return;
              const databaseClockAt = clock.getTime();
              client.send(
                JSON.stringify({
                  type: 'trace-painted',
                  id: item.id,
                  databaseAt: trace.databaseAt,
                  databaseClockAt,
                  upperBoundMs: databaseClockAt - trace.databaseAt,
                }),
              );
              return;
            }
            if (typeof trace.startedAt !== 'number') return;
            const serverReceivedAt = Date.now();
            client.send(
              JSON.stringify({
                type: 'trace-painted',
                id: item.id,
                startedAt: trace.startedAt,
                databaseAt: trace.databaseAt,
                serverReceivedAt,
                upperBoundMs: serverReceivedAt - trace.startedAt,
              }),
            );
            return;
          }
          if (
            item.type === 'subscribe' &&
            typeof item.roomId === 'string' &&
            (await options.phone.canReadRoom(item.roomId, principal.identityId)) &&
            !releases.has(item.roomId)
          ) {
            if (principal.kind === 'daemon') {
              const roomId = item.roomId;
              let cursor = isInboxCursor(item.cursor) ? item.cursor : undefined;
              let replaying = false;
              let replayRequested = false;
              let replayTrigger: { reason: string; trace: LiveTrace } | undefined;
              let commandsPushing = false;
              let commandsRequested = false;
              let commandTrigger: { reason: string; trace: LiveTrace } | undefined;
              const replay = async (trigger?: { reason: string; trace: LiveTrace }) => {
                replayRequested = true;
                if (trigger) replayTrigger = trigger;
                if (replaying) return;
                replaying = true;
                try {
                  while (replayRequested && client.readyState === client.OPEN) {
                    replayRequested = false;
                    const inbox = await options.daemon.execute(
                      'getRoomInbox',
                      {
                        roomId,
                        ...(cursor ? { after: cursor, rewind: true } : { startAtLatest: true }),
                        limit: 200,
                      },
                      principal.identityId,
                    );
                    cursor = inbox.cursor ?? cursor;
                    const currentTrigger = replayTrigger;
                    replayTrigger = undefined;
                    client.send(
                      JSON.stringify({
                        type: 'inbox',
                        roomId,
                        items: inbox.items,
                        ...(cursor ? { cursor } : {}),
                        ...(currentTrigger ? { trigger: currentTrigger } : {}),
                      }),
                    );
                  }
                } catch (error) {
                  console.error(
                    '[live] daemon replay failed',
                    error instanceof Error ? error.message : String(error),
                  );
                } finally {
                  replaying = false;
                }
              };
              const pushCommands = async (trigger?: { reason: string; trace: LiveTrace }) => {
                commandsRequested = true;
                if (trigger) commandTrigger = trigger;
                if (commandsPushing) return;
                commandsPushing = true;
                try {
                  while (commandsRequested && client.readyState === client.OPEN) {
                    commandsRequested = false;
                    const page = await options.daemon.execute(
                      'getAgentCommands',
                      { roomId },
                      principal.identityId,
                    );
                    const currentTrigger = commandTrigger;
                    commandTrigger = undefined;
                    client.send(
                      JSON.stringify({
                        type: 'commands',
                        roomId,
                        commandProtocol: page.commandProtocol,
                        commands: page.commands,
                        ...(currentTrigger ? { trigger: currentTrigger } : {}),
                      }),
                    );
                  }
                } catch (error) {
                  console.error(
                    '[live] daemon command push failed',
                    error instanceof Error ? error.message : String(error),
                  );
                } finally {
                  commandsPushing = false;
                }
              };
              releases.set(
                roomId,
                options.live.subscribe(roomId, (event) => {
                  const trigger =
                    event.type === 'invalidate' && event.trace
                      ? { reason: event.reason, trace: event.trace }
                      : undefined;
                  void replay(trigger);
                  if (
                    event.type === 'invalidate' &&
                    event.reason === 'postgres:agent_commands' &&
                    event.targetAgentId === principal.identityId
                  )
                    void pushCommands(trigger);
                }),
              );
              const lifecycleId =
                typeof item.lifecycleId === 'string' && item.lifecycleId.length <= 128
                  ? item.lifecycleId
                  : undefined;
              if (lifecycleId)
                try {
                  await options.connectionPresence?.announce(roomId, principal.identityId, {
                    lifecycleId,
                    ...(typeof item.releaseVersion === 'string'
                      ? { releaseVersion: item.releaseVersion }
                      : {}),
                    ...(typeof item.sourceSha === 'string' ? { sourceSha: item.sourceSha } : {}),
                    ...(typeof item.available === 'boolean' ? { available: item.available } : {}),
                  });
                } catch (error) {
                  console.error('[presence] startup announcement failed', error);
                  client.close(1011, 'startup announcement failed');
                  return;
                }
              if (client.readyState !== client.OPEN) return;
              client.send(
                JSON.stringify({
                  type: 'subscribed',
                  roomId,
                  capabilities: {
                    pushIntake: true,
                    connectionPresence: Boolean(options.connectionPresence),
                  },
                }),
              );
              await Promise.all([replay(), pushCommands()]);
              return;
            }
            // Agents whose draft this socket has already been handed live.
            // The snapshot below is read asynchronously, so a delta can land
            // first; replacing it with the older row would show the reader the
            // answer going backwards.
            const streamed = new Set<string>();
            let deltaDelivery = Promise.resolve();
            releases.set(
              item.roomId,
              options.live.subscribe(item.roomId, (event) => {
                if (event.type === 'draft') streamed.add(event.agentId);
                if (event.type !== 'invalidate') {
                  if (client.readyState === client.OPEN) client.send(JSON.stringify(event));
                  return;
                }
                // committedRow is process-local authority input. Strip it
                // before every wire branch, including malformed/no-target
                // invalidations, so only a projected public delta can leave.
                const { committedRow, ...wireEvent } = event;
                const target = event.messageId
                  ? ({ type: 'message' as const, messageId: event.messageId } as const)
                  : event.agentId && event.requestId
                    ? ({
                        type: 'turn' as const,
                        agentId: event.agentId,
                        requestId: event.requestId,
                      } as const)
                    : undefined;
                if (!target) {
                  if (client.readyState === client.OPEN) client.send(JSON.stringify(wireEvent));
                  return;
                }
                const trace = event.trace;
                const wireTrace =
                  trace && options.livePaintDiagnostics && typeof trace.startedAt !== 'number'
                    ? ({ ...trace, paintAck: 'database-clock' as const } satisfies LiveTrace)
                    : trace;
                const fallback = {
                  ...wireEvent,
                  ...(wireTrace ? { trace: wireTrace } : {}),
                  reason: `delta-fallback:${event.reason}`,
                };
                // Begin every bounded row read immediately. Only delivery is
                // serialized, preserving commit-notification order without a
                // slow lookup preventing later reads from making progress.
                let projectionError: unknown;
                let committedDelta;
                try {
                  committedDelta = committedRow
                    ? options.phone.projectCommittedLiveDelta(item.roomId as string, committedRow)
                    : undefined;
                } catch (error) {
                  projectionError = error;
                }
                // An internal row must agree with the Room-scoped bus key. A
                // mismatch is neither serialized nor retried against attacker-
                // controlled ids; the canonical PostgreSQL hint remains the
                // independent recovery path for the real Room.
                if (committedRow && !committedDelta && !projectionError) return;
                const pendingDelta = (
                  projectionError
                    ? Promise.reject(projectionError)
                    : committedDelta
                      ? Promise.resolve(committedDelta)
                      : withinLiveDeltaDeadline(
                          options.phone.readLiveDelta(
                            item.roomId as string,
                            principal.identityId,
                            target,
                          ),
                        )
                ).then(
                  (delta) => ({ delta }) as const,
                  (error: unknown) => ({ error }) as const,
                );
                deltaDelivery = deltaDelivery
                  .then(async () => {
                    const result = await pendingDelta;
                    if (client.readyState !== client.OPEN) return;
                    if ('error' in result) throw result.error;
                    rememberPaintTrace(wireTrace);
                    client.send(
                      JSON.stringify(
                        result.delta
                          ? { ...result.delta, ...(wireTrace ? { trace: wireTrace } : {}) }
                          : fallback,
                      ),
                    );
                  })
                  .catch((error) => {
                    console.error(
                      '[live] committed row delivery failed',
                      error instanceof Error ? error.message : String(error),
                    );
                    if (client.readyState === client.OPEN) {
                      rememberPaintTrace(wireTrace);
                      client.send(JSON.stringify(fallback));
                    }
                  });
              }),
            );
            client.send(JSON.stringify({ type: 'subscribed', roomId: item.roomId }));
            // A live lane carries only what is written after this point, so a
            // reader who joins a turn already in progress has missed the draft
            // it is writing. Hand over the running one now; every later delta
            // arrives through the subscription above and replaces it. A read
            // that fails leaves the lane exactly as it was before.
            const snapshot = await options.phone
              .liveDraftSnapshot(item.roomId)
              .catch(() => [] as LiveEvent[]);
            for (const event of snapshot) {
              if (event.type === 'draft' && streamed.has(event.agentId)) continue;
              if (client.readyState === client.OPEN) client.send(JSON.stringify(event));
            }
            for (const event of options.live.presenceSnapshot(item.roomId)) {
              if (client.readyState === client.OPEN) client.send(JSON.stringify(event));
            }
          }
          if (item.type === 'unsubscribe' && typeof item.roomId === 'string') {
            releases.get(item.roomId)?.();
            releases.delete(item.roomId);
          }
        })();
      });
      client.on('close', () => {
        pendingPaintTraces.clear();
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
/**
 * Why a daemon request was refused, in the only two shapes a helper may act
 * on. `agent_removed` is a settled fact — the token is revoked and its agent
 * holds no membership anywhere — and is what lets the helper stop itself.
 * Everything else stays the ordinary 401 it retries against.
 */
async function refuseDaemon(
  request: IncomingMessage,
  response: ServerResponse,
  options: ServerOptions,
): Promise<void> {
  const value = bearer(request.headers.authorization);
  const retired = value ? await options.auth.retiredDaemonAgent(value) : null;
  if (retired) json(response, 403, { error: 'agent_removed' });
  else json(response, 401, { error: 'daemon_token_required' });
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  options: ServerOptions,
  invitePreview: InvitePreviewAccess,
): Promise<void> {
  const url = exactPath(request.url);
  const method = request.method ?? 'GET';
  if (options.authHandler && url.pathname.startsWith('/auth/')) {
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
  if (method === 'GET' && url.pathname === '/v1/public/invite-preview') {
    // The bearer invite stays in the query string because request logging records
    // only the pathname; do not put it in a path segment that becomes log data.
    const result = await invitePreview.resolve(
      url.searchParams.get('token') ?? '',
      clientKey(request),
    );
    if (result.status === 'found') publicJson(response, 200, result.preview);
    else if (result.status === 'rate_limited')
      publicJson(response, 429, { error: 'too_many_requests' });
    else publicJson(response, 404, { valid: false });
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/auth/daemon/rollback') {
    const input = await body(request);
    if (typeof input.exchangeToken !== 'string') throw new Error('exchangeToken is required');
    const agentId = await options.auth.consumeDaemonExchangeAgent(input.exchangeToken);
    if (!agentId) throw new Error('pairing not found');
    await options.phone.rollbackUnrealizedAgent(agentId);
    json(response, 204, {});
    return;
  }
  if (method === 'GET' && url.pathname === '/v1/releases/daemon-readiness') {
    json(response, 200, await options.daemon.releaseReadiness());
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/releases/notify') {
    if (
      !options.releaseNotify?.secret ||
      !bearerSecretMatches(options.releaseNotify.secret, request)
    )
      throw new Error('release notify access denied');
    const input = await body(request);
    if (
      typeof input.version !== 'string' ||
      typeof input.sha !== 'string' ||
      typeof input.changelogUrl !== 'string'
    ) {
      throw new Error('version, sha and changelogUrl are required');
    }
    json(
      response,
      200,
      await options.releaseNotify.notifyReleaseDelivered({
        version: input.version,
        sha: input.sha,
        changelogUrl: input.changelogUrl,
      }),
    );
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/auth/github/reconnect') {
    const viewerId = await phoneIdentity(request, options);
    if (!viewerId) {
      json(response, 401, { error: 'unauthorized' });
      return;
    }
    const input = await body(request);
    if (typeof input.oidcToken !== 'string') throw new Error('oidcToken is required');
    const matched = await options.auth.reconnectGitHub(viewerId, input.oidcToken);
    if (!matched) json(response, 409, { error: 'github_account_mismatch' });
    else {
      response.writeHead(204);
      response.end();
    }
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/auth/github/exchange') {
    const input = await body(request);
    if (typeof input.oidcToken !== 'string') throw new Error('oidcToken is required');
    json(response, 200, await options.auth.exchangeGitHubOidc(input.oidcToken));
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/auth/review/exchange') {
    const input = await body(request);
    const redemption = await (options.review?.redeem(input.secret, clientKey(request)) ??
      Promise.resolve({ status: 'refused' as const }));
    if (redemption.status === 'redeemed') json(response, 200, redemption.tokens);
    // A rate limit is the only thing a client is told; an unknown secret and an
    // unconfigured server are the same ordinary 404, so neither is a hint.
    else if (redemption.status === 'rate_limited')
      json(response, 429, { error: 'too_many_requests' });
    else json(response, 404, { error: 'not_found' });
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
    const completed = await options.database.query(
      `SELECT 1 FROM github_webhook_deliveries WHERE delivery_id=$1`,
      [delivery],
    );
    if (completed.rowCount) {
      json(response, 200, { accepted: false, duplicate: true });
      return;
    }
    if (options.github?.onWebhook) await options.github.onWebhook(event, parsed);
    const inserted = await options.database.query(
      `INSERT INTO github_webhook_deliveries(delivery_id,event_type,payload,processed_at)
       VALUES($1,$2,$3::jsonb,now()) ON CONFLICT DO NOTHING`,
      [delivery, event, JSON.stringify(parsed)],
    );
    const accepted = Boolean(inserted.rowCount);
    json(response, accepted ? 202 : 200, {
      accepted,
      duplicate: !accepted,
    });
    return;
  }

  const identityId = await phoneIdentity(request, options);
  if (method === 'GET' && url.pathname.startsWith('/v1/avatars/')) {
    const id = url.pathname.slice('/v1/avatars/'.length);
    const avatar = isMediaId(id)
      ? (
          await options.database.query<{ bytes: Uint8Array }>(
            'SELECT bytes FROM avatars WHERE id=$1',
            [id],
          )
        ).rows[0]
      : undefined;
    if (!avatar) {
      json(response, 404, { error: 'avatar_not_found' });
      return;
    }
    response.writeHead(200, {
      'content-type': 'image/webp',
      'content-length': String(avatar.bytes.length),
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    });
    response.end(Buffer.from(avatar.bytes));
    return;
  }
  if (method === 'GET' && url.pathname.startsWith('/v1/media/')) {
    const mediaId = url.pathname.slice('/v1/media/'.length);
    // An id that is not a UUID never named a row, and must not reach the uuid
    // cast below, where Postgres would answer a client typo with a 500.
    if (!isMediaId(mediaId)) {
      json(response, 404, { error: 'media_not_found' });
      return;
    }
    const media = (
      await options.database.query<{ bytes: Uint8Array; mime_type: string; name: string }>(
        `SELECT bytes,mime_type,name FROM media WHERE id=$1`,
        [mediaId],
      )
    ).rows[0];
    if (!media) {
      // Bytes past the media TTL are gone for good, and say so: a client that
      // reads 410 renders "expired" instead of retrying a 404 forever.
      const expired = (
        await options.database.query(`SELECT 1 FROM media_expirations WHERE id=$1`, [mediaId])
      ).rows.length;
      json(response, expired ? 410 : 404, {
        error: expired ? 'media_expired' : 'media_not_found',
        ...(expired ? { ttlHours: mediaTtlHours() } : {}),
      });
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
    const invalidatedRoom =
      typeof input.roomId === 'string'
        ? input.roomId
        : result && typeof (result as { roomId?: unknown }).roomId === 'string'
          ? (result as { roomId: string }).roomId
          : undefined;
    if (invalidatedRoom)
      options.live.publish({ type: 'invalidate', roomId: invalidatedRoom, reason: 'phone-write' });
    if (result === undefined) {
      response.writeHead(204, { 'cache-control': 'private, no-store' });
      response.end();
      return;
    }
    json(response, 200, result);
    return;
  }

  if (method === 'POST' && url.pathname === '/v1/daemon/media') {
    const agentId = await daemonIdentity(request, options);
    if (!agentId) {
      await refuseDaemon(request, response, options);
      return;
    }
    await options.connectionPresence?.evidence(undefined, agentId);
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
      await options.phone.uploadMedia(agentId, raw, mime, name, options.mediaMaximumBytes),
    );
    return;
  }
  match = url.pathname.match(/^\/v1\/daemon\/operations\/([A-Za-z][A-Za-z0-9]+)$/);
  if (method === 'POST' && match) {
    const agentId = await daemonIdentity(request, options);
    if (!agentId) {
      await refuseDaemon(request, response, options);
      return;
    }
    const name = match[1]!;
    if (!DAEMON_OPERATION_NAMES.has(name as never)) {
      json(response, 404, { error: 'unknown_daemon_operation' });
      return;
    }
    const input = await body(request);
    const evidenceRoom =
      typeof input.roomId === 'string'
        ? input.roomId
        : typeof input.cornerId === 'string'
          ? input.cornerId
          : undefined;
    await options.connectionPresence?.evidence(evidenceRoom, agentId);
    json(response, 200, await options.daemon.execute(name as never, input as never, agentId));
    return;
  }
  json(response, 404, { error: 'not_found' });
}
