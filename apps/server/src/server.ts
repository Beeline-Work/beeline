import { type Server, createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { runnableOrigin, serveRunnableArtifact } from "./runnable-artifact.js";
import type { LiveEvent, LiveHub } from "./live.js";
import { type RoomLiveDelta, type MessageBookmarkView, PHONE_READ_OPERATIONS } from "@beeline/api-contract/phone";
import type { PhoneService } from "./phone-service.js";
import { HelperVersionGate, helperVersionBelowMinimum } from "./helper-version-gate.js";
import { WebSocketServer, type WebSocket } from "ws";
import type { Duplex } from "node:stream";
import { DaemonConnectionRegistry, type DaemonLiveDependencies } from "./daemon-live.js";
import { VaultSaveRelay } from "./vault-save-relay.js";
import { InvitePreviewAccess } from "./invite-preview.js";
import { PhoneViewing } from "./phone-viewing.js";
import { randomUUID, createHmac, timingSafeEqual, createHash } from "node:crypto";
import { createPhoneOperationDispatcher, PhoneOperationError } from "./phone-operations.js";
import { acceptedJsonEncoding, type JsonEncoding, encodeJsonBody } from "./json-response.js";
import { recordOperatorFunctionEvent } from "./operator-dashboard.js";
import { vaultSaveHttp } from "./vault-save-http.js";
import { GitHubHttpError } from "@beeline/auth/github";
import { captureServerError } from "./sentry.js";
import { upgradeComputerSession, upgradeBodyComputerSource, upgradeComputerWaiter } from "./computer-session.js";
import { bearer, type TokenAuth } from "./auth.js";
import type { RoomsMcp } from "./rooms-mcp.js";
import type { SentryTelegramConfig } from "./sentry-telegram.js";
import { type SqlDatabase, isTransientDatabaseConnectionError } from "./database.js";
import type { DaemonService } from "./daemon-service.js";
import type { ConnectionPresence } from "./connection-presence.js";
import type { FreeAgentService } from "./free-agents.js";
import type { FreeAgentModelProxyOptions } from "./free-agent-model-proxy.js";
import type { ObjectService } from "./object-service.js";
import type { ComposioApps } from "./composio-apps.js";
import type { LinkAgentWallet } from "./link-agent-wallet.js";
import type { RegistryMcpOAuth } from "./registry-mcp-oauth.js";
import type { ReviewAccess } from "./review-access.js";
import type { ReleaseNotifier } from "./release-notify.js";
import type { SpeechTranscriber } from "./speech-transcription.js";
import type { VoiceService } from "./voice-service.js";
import { FunnelRateLimit } from "./signin-funnel.js";
import { MACHINE_SOCKET_PROTOCOL } from "./machine-connection.js";
import { requestErrorStatus } from './server-request-error-status.js';
import { PhoneHttpOperation, NON_PHONE_HTTP_WRITES, readPhoneSession } from './server-create-beeline-server.js';
import { route } from './server-route.js';
import { handleLiveConnection } from './server-live-connection.js';





export const DEFAULT_MEDIA_MAXIMUM_BYTES = 25 * 1024 * 1024;



export const MAX_JSON_BYTES = 1024 * 1024;




// A reconnecting helper may send all of its Room subscriptions at once. Keep
// those reads outside pg-pool's queue, where they would otherwise time out and
// amplify the reconnect. Older helpers need no new protocol to use this gate.
// The gate scales with the machine's app pool and leaves four of its
// connections to ordinary requests, so live work never takes all of them.
export const MIN_LIVE_DB_TASKS = 2;


export const LIVE_DB_RESERVED_APP_CONNECTIONS = 4;


export function maxLiveDbTasks(appConnections: number | undefined): number {
  return Math.max(MIN_LIVE_DB_TASKS, (appConnections ?? 0) - LIVE_DB_RESERVED_APP_CONNECTIONS);
}


export const MAX_LIVE_WAITING_TASKS = 512;


export const MAX_LIVE_OUTBOUND_BUFFERED_BYTES = 16 * 1024 * 1024;


/** Rows one socket remembers for `admitRow`; rows with a read in flight stay. */
export const SENT_ROW_LIMIT = 256;


/** A message's version, or the live epoch and sequence a corner status was read for. */
export type RowOrder = { version: number };


export type SentRow = { order?: RowOrder; fingerprint?: string; reads: number };



/** Whether `next` is not newer than the frame already sent; unordered frames always are newer. */
export function rowOrderIsNotNewer(next: RowOrder | undefined, sent: RowOrder | undefined): boolean {
  if (!next || !sent) return false;
  return next.version <= sent.version;
}


export const LIVE_PING_FRAME = JSON.stringify({ type: 'ping' });


export const LIVE_PONG_FRAME = JSON.stringify({ type: 'pong' });


export const ROOM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;


/** Machine sockets authenticate per agent after upgrade; cap them per client address. */
export const MAX_MACHINE_SOCKETS_PER_CLIENT = 8;


export interface GitHubServerHooks {
  webhookSecret?: string;
  roomToken?: (identityId: string, roomId: string) => Promise<{ token: string; expiresAt: number }>;
  onWebhook?: (eventType: string, payload: unknown, deliveryId?: string) => Promise<void>;
  completeInstallation?: (state: string, installationId: number) => Promise<string>;
}



export interface ServerOptions {
  /** Production enables this with the router; object storage and authority remain required. */
  operationOutcomes?: import('./operation-outcomes.js').OperationOutcomes;
  roomsMcp?: RoomsMcp;
  sentryWakeSecret?: string;
  sentryWakeAgentId?: string;
  sentryTelegram?: SentryTelegramConfig;
  database: SqlDatabase;
  /** CDP receiver id -> subscription signing secret, server-only. */
  cdpWebhookSecrets?: Readonly<Record<string, string>>;
  /** Deployment capacity calculated from PostgreSQL max_connections at boot. */
  databaseBudget?: import('./database-budget.js').DatabaseConnectionBudget;
  enrichmentDatabase?: SqlDatabase;
  jobsDatabase?: SqlDatabase;
  /** A one-connection app-role pool kept outside request traffic so health
   * remains observable while the main pool is saturated. */
  healthDatabase?: SqlDatabase;
  /** Per-job last success, duration, and error counters from the leader. */
  backgroundHealth?: () => Record<string, unknown>;
  /** PostgreSQL notification projection pressure for this server instance. */
  liveBridgeHealth?: () => Record<string, unknown>;
  /** Process/known dependency verdict. Hosting probes must not observe SQL. */
  readiness?: () => boolean;
  /** Per-instance pool telemetry; the existing `database.pool` app shape is
   * retained for older release probes. */
  databasePools?: Partial<Record<'app' | 'enrichment' | 'diagnostics' | 'jobs', SqlDatabase>>;
  auth: TokenAuth;
  legacyMigrationOrigin?: string;
  phone: PhoneService;
  daemon: DaemonService;
  live: LiveHub;
  connectionPresence?: ConnectionPresence;
  /** Free starter agents: Machine wake/sleep and first-boot bootstrap. */
  freeAgents?: FreeAgentService;
  /** The free agents' model proxy; absent refuses every model call. */
  freeAgentModel?: FreeAgentModelProxyOptions;
  mediaMaximumBytes: number;
  /** Absent when no S3 env is configured: object writes then refuse with a
   *  clear 503. */
  objectService?: ObjectService;
  github?: GitHubServerHooks;
  composio?: ComposioApps;
  composioReceiverUrl?: string;
  linkWallet?: LinkAgentWallet;
  registryMcpOAuth?: RegistryMcpOAuth;
  /** Absent when no review secret is configured; the endpoint then refuses like any wrong secret. */
  review?: ReviewAccess;
  /** Absent when no release-notify secret is configured; the endpoint then refuses like any wrong secret. */
  releaseNotify?: ReleaseNotifier;
  /** Absent without `GROQ_API_KEY`: dictation keeps the phone's on-device text. */
  speechTranscriber?: SpeechTranscriber;
  voice?: VoiceService;
  helperVersionGate?: HelperVersionGate;
  /** Server-side secret for the private operator proxy only. */
  dashboardSecret?: string;
  /** Diagnostics only: one DB-clock read after an authorized cross-process
   * delta is painted. Ordinary live delivery performs no extra query. */
  livePaintDiagnostics?: boolean;
  authHandler?: (request: IncomingMessage, response: ServerResponse) => void;
  /** Exact browser origins allowed to call the bearer-authenticated HTTP API. */
  webAppOrigins?: readonly string[];
}



export const appSignInReturnCookie = 'beeline_app_sign_in_return';



/** The configured web origin this browser started app sign-in from, if any. */
export function appSignInWebOrigin(request: IncomingMessage, options: ServerOptions): string | undefined {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name !== appSignInReturnCookie) continue;
    let origin: string;
    try { origin = decodeURIComponent(value.join('=')); } catch { return undefined; }
    return options.webAppOrigins?.includes(origin) ? origin : undefined;
  }
  return undefined;
}



export function applyWebAppCors(
  request: IncomingMessage,
  response: ServerResponse,
  options: ServerOptions,
): boolean {
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || !options.webAppOrigins?.includes(origin)) return false;

  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('vary', 'Origin');
  if (request.method !== 'OPTIONS') return false;

  response.writeHead(204, {
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'authorization, content-type, x-file-name, x-beeline-view, x-speech-language, x-speech-prompt',
    'access-control-max-age': '600',
    'cache-control': 'private, no-store',
  });
  response.end();
  return true;
}



export function isWebAppCorsPath(pathname: string): boolean {
  if (pathname === '/v1/admin/dashboard') return false;
  return (
    pathname === '/healthz' ||
    pathname.startsWith('/v1/') ||
    pathname === '/auth/capabilities' ||
    pathname === '/auth/github/completion' ||
    pathname === '/auth/github/completion/cancel' ||
    pathname === '/auth/oidc/completion' ||
    pathname === '/auth/oidc/completion/cancel'
  );
}



/** What each request accepts for a JSON answer, read once where it arrives. */
export const jsonEncodings = new WeakMap<ServerResponse, JsonEncoding>();


export const roomRequestStartedAt = new WeakMap<ServerResponse, number>();



export function json(response: ServerResponse, status: number, body: unknown): void {
  const { bytes, encoding } = encodeJsonBody(body, jsonEncodings.get(response));
  // writeHead replaces a header set earlier, and CORS already set `vary: Origin`.
  const vary = response.getHeader('vary');
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'private, no-store',
    ...(roomRequestStartedAt.has(response)
      ? { 'server-timing': `app;dur=${(performance.now() - roomRequestStartedAt.get(response)!).toFixed(1)}` }
      : {}),
    ...(encoding
      ? {
          'content-encoding': encoding,
          vary: vary ? `${String(vary)}, accept-encoding` : 'accept-encoding',
        }
      : {}),
  });
  response.end(bytes);
}



export function publicJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'x-content-type-options': 'nosniff',
  });
  response.end(`${JSON.stringify(body)}\n`);
}



export async function bytes(request: IncomingMessage, maximum: number): Promise<Buffer> {
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


export const funnelRateLimit = new FunnelRateLimit();


export async function body(request: IncomingMessage, allowEmptyVoiceBody = false): Promise<Record<string, unknown>> {
  const raw = await bytes(request, MAX_JSON_BYTES);
  if (!raw.length) return {};
  const text = raw.toString('utf8');
  // Android expo/fetch can encode a bodyless voice action as a NUL byte.
  if (allowEmptyVoiceBody && /^[\s\u0000]*$/u.test(text)) return {};
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('JSON object required');
  return parsed as Record<string, unknown>;
}


export function exactPath(urlValue: string | undefined): URL {
  return new URL(urlValue ?? '/', 'http://server.invalid');
}


export function tokenFromProtocol(request: IncomingMessage): string | null {
  const protocol = request.headers['sec-websocket-protocol'];
  if (typeof protocol !== 'string') return null;
  const value = protocol
    .split(',')
    .map((item) => item.trim())
    .find((item) => item.startsWith('bearer.'));
  return value ? value.slice('bearer.'.length) : null;
}


export function isMachineSocket(request: IncomingMessage): boolean {
  const protocol = request.headers['sec-websocket-protocol'];
  return (
    typeof protocol === 'string' &&
    protocol.split(',').some((item) => item.trim() === MACHINE_SOCKET_PROTOCOL)
  );
}


export function isRetryableLiveError(error: unknown): boolean {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return isTransientDatabaseConnectionError(error) || code === '57014' || code === '53300';
}


/** Who a rate limit counts against: the edge's client address, else the socket peer. */
export function clientKey(request: IncomingMessage): string {
  const forwarded = request.headers['fly-client-ip'] ?? request.headers['x-forwarded-for'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = value?.split(',')[0]?.trim();
  return first || request.socket.remoteAddress || 'unknown';
}


export function signatureMatches(secret: string, payload: Buffer, header: string | undefined) {
  if (!header?.startsWith('sha256=')) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}


/** Constant time over fixed-width digests, so neither the secret nor its length leaks. */
export function bearerSecretMatches(secret: string, request: IncomingMessage): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(header.slice('Bearer '.length)), digest(secret));
}




export function createBeelineServer(options: ServerOptions): Server {
  const gameOrigin = runnableOrigin();
  // LiveHub invokes every socket listener synchronously with the same event.
  // Gather those viewers before the microtask starts one authorized row read.
  // Weak keys release the batch when the notification leaves the bus.
  const liveRowBatches = new WeakMap<LiveEvent, {
    viewers: Set<string>;
    result: Promise<ReadonlyMap<string, RoomLiveDelta>>;
  }>();
  const bookmarkReads = new WeakMap<LiveEvent, Promise<MessageBookmarkView | null>>();
  // Share one projection read across sockets for each change.
  const workspaceChangeReads = new WeakMap<LiveEvent,
    ReturnType<PhoneService['liveWorkspaceChange']>>();
  const personChangeReads = new WeakMap<LiveEvent,
    ReturnType<PhoneService['livePersonChange']>>();
  const readChange = <T>(cache: WeakMap<LiveEvent, Promise<T>>, event: LiveEvent,
    load: () => Promise<T>): Promise<T> => {
    let read = cache.get(event);
    if (!read) {
      read = withLiveDbTask(load);
      cache.set(event, read);
    }
    return read;
  };
  const readWorkspaceChange = (event: LiveEvent, id: string) =>
    readChange(workspaceChangeReads, event, () => options.phone.liveWorkspaceChange(id));
  const readPersonChange = (event: LiveEvent, id: string) =>
    readChange(personChangeReads, event, () => options.phone.livePersonChange(id));
  const cornerStatusReads = new WeakMap<LiveEvent, Map<string,
    ReturnType<PhoneService['liveChatCornerStatus']>>>();
  const readCornerStatusForViewer = (event: LiveEvent, roomId: string, viewerId: string) => {
    let viewers = cornerStatusReads.get(event);
    if (!viewers) {
      viewers = new Map();
      cornerStatusReads.set(event, viewers);
    }
    let read = viewers.get(viewerId);
    if (!read) {
      read = withLiveDbTask(() => options.phone.liveChatCornerStatus(roomId, viewerId))
        .finally(() => {
          viewers!.delete(viewerId);
          if (!viewers!.size) cornerStatusReads.delete(event);
        });
      viewers.set(viewerId, read);
    }
    return read;
  };
  const needsYouReads = new WeakMap<LiveEvent, Map<string,
    ReturnType<PhoneService['liveNeedsYou']>>>();
  const readNeedsYouForViewer = (event: LiveEvent, roomId: string, viewerId: string) => {
    let viewers = needsYouReads.get(event);
    if (!viewers) {
      viewers = new Map();
      needsYouReads.set(event, viewers);
    }
    let read = viewers.get(viewerId);
    if (!read) {
      read = withLiveDbTask(() => options.phone.liveNeedsYou(roomId, viewerId))
        .finally(() => {
          viewers!.delete(viewerId);
          if (!viewers!.size) needsYouReads.delete(event);
        });
      viewers.set(viewerId, read);
    }
    return read;
  };
  const readLiveRowForViewer = (
    event: LiveEvent,
    roomId: string,
    viewerId: string,
    target: { type: 'message'; messageId: string } |
      { type: 'turn'; agentId: string; requestId: string },
  ): Promise<RoomLiveDelta | null> => {
    let batch = liveRowBatches.get(event);
    if (!batch) {
      const viewers = new Set<string>();
      batch = {
        viewers,
        result: Promise.resolve().then(() => {
          // The synchronous fanout is complete. A later cursor replay of this
          // event must authorize its own viewers against current membership.
          liveRowBatches.delete(event);
          return withLiveDbTask(() => options.phone.readLiveDeltas(
            roomId, [...viewers], target,
          ));
        }),
      };
      liveRowBatches.set(event, batch);
    }
    batch.viewers.add(viewerId);
    return batch.result.then((deltas) => deltas.get(viewerId) ?? null);
  };
  const helperVersionGate =
    options.helperVersionGate ?? new HelperVersionGate(process.env.BEELINE_MIN_HELPER_VERSION);
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: 0 });
  const liveDbTaskLimit = maxLiveDbTasks(options.databaseBudget?.app);
  let liveDbTasks = 0;
  const liveDbWaiters: Array<() => void> = [];
  const socketCounts = new Map<string, number>();
  /** Admitted daemon sockets per agent on this machine; a newer upgrade retires them. */
  const daemonSockets = new Map<string, Set<{ socket: Duplex; release: () => void }>>();
  const socketSubscriptions = new Map<WebSocket, () => number>();
  const liveErrors = { database: 0, invalid: 0, internal: 0, overload: 0 };
  const liveCounters = {
    helperVersionRefusals: 0,
    helperForceUpdates: 0,
    heartbeatTerminations: 0,
  };
  const machineSocketCounts = new Map<string, number>();
  const liveHealth = () => ({
    sockets: webSockets.clients.size,
    subscriptions: [...socketSubscriptions.values()].reduce((total, count) => total + count(), 0),
    activeDbTasks: liveDbTasks,
    waitingDbTasks: liveDbWaiters.length,
    errors: { ...liveErrors },
    heartbeatTerminations: liveCounters.heartbeatTerminations,
    ...(helperVersionGate.minimum
      ? {
          helperMinimum: {
            minVersion: helperVersionGate.minimum,
            refusals: liveCounters.helperVersionRefusals,
            forceUpdates: liveCounters.helperForceUpdates,
          },
        }
      : {}),
  });
  const releaseLiveDbTask = () => {
    const next = liveDbWaiters.shift();
    if (next) next();
    else liveDbTasks--;
  };
  const acquireLiveDbTask = async (): Promise<() => void> => {
    if (liveDbTasks < liveDbTaskLimit) {
      liveDbTasks++;
      return releaseLiveDbTask;
    }
    if (liveDbWaiters.length >= MAX_LIVE_WAITING_TASKS)
      throw new Error('live admission overloaded');
    await new Promise<void>((resolve) => liveDbWaiters.push(resolve));
    return releaseLiveDbTask;
  };
  const withLiveDbTask = async <T>(work: () => Promise<T>): Promise<T> => {
    const release = await acquireLiveDbTask();
    try { return await work(); }
    finally { release(); }
  };
  const daemonRegistry = new DaemonConnectionRegistry();
  const vaultSaveRelay = new VaultSaveRelay();
  let shuttingDown = false;
  const daemonLive: DaemonLiveDependencies = {
    operationErrorStatus: requestErrorStatus,
    auth: options.auth,
    phone: options.phone,
    daemon: options.daemon,
    live: options.live,
    database: options.database,
    ...(options.connectionPresence ? { connectionPresence: options.connectionPresence } : {}),
    ...(options.releaseNotify ? { releaseNotify: options.releaseNotify } : {}),
    helperVersionGate,
    acquireLiveDbTask,
    errors: liveErrors,
    counters: liveCounters,
    registry: daemonRegistry,
    vaultSaveRelay,
    shuttingDown: () => shuttingDown,
  };
  // Another server instance accepted a newer connection for an agent this
  // instance still serves: drop ours. Own claims arrive here too and change nothing.
  let releaseConnectionEpochs: (() => void) | undefined;
  const watchConnectionEpochs = () => {
    releaseConnectionEpochs ??= options.live.subscribeAll((event) => {
      if (event.type === 'agent-connection')
        daemonRegistry.observeEpoch(event.agentId, event.epoch);
    });
  };
  const invitePreview = new InvitePreviewAccess(options.database);
  const phoneViewing = new PhoneViewing(options.database, options.connectionPresence?.instanceId ?? randomUUID());
  const dispatchPhoneOperation = createPhoneOperationDispatcher(options, requestErrorStatus);
  // Deployment/free-agent proof tools and the corner fixture controller are non-phone HTTP clients.
  // Keep only their named commands; phone actions use the live socket.
  const httpPhoneOperation: PhoneHttpOperation = (name, input, viewerId, familyId) => {
    if (!(PHONE_READ_OPERATIONS as readonly string[]).includes(name) &&
        !(NON_PHONE_HTTP_WRITES as readonly string[]).includes(name))
      throw new PhoneOperationError(404, { error: 'not_found' });
    if ((name === 'readNeedsYou' || name === 'readTray') && input.markSeen !== false)
      throw new PhoneOperationError(409, { error: 'phone_socket_required' });
    return dispatchPhoneOperation(name, input, viewerId, undefined, familyId);
  };
  const server = createServer((request, response) => {
    if (gameOrigin && request.headers.host === new URL(gameOrigin).host) {
      void serveRunnableArtifact(request, response, gameOrigin, options.objectService).catch(() => {
        if (!response.headersSent) response.writeHead(503, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
        response.end('Unavailable');
      });
      return;
    }
    const url = exactPath(request.url);
    const method = request.method ?? 'GET';
    if (method === 'GET' && /^\/v1\/phone\/rooms\/[^/]+$/.test(url.pathname))
      roomRequestStartedAt.set(response, performance.now());
    const encoding = acceptedJsonEncoding(request.headers['accept-encoding']);
    if (encoding) jsonEncodings.set(response, encoding);
    const observedFunction =
      method === 'POST' &&
      (url.pathname === '/v1/phone/media' || url.pathname === '/v1/daemon/uploads')
        ? 'attachment_upload'
        : method === 'POST' && url.pathname === '/v1/daemon/operations/createCorner'
          ? 'corner_open' : null;
    if (observedFunction) {
      const started = performance.now();
      response.once('finish', () => {
        // The observation is after the response. It cannot delay the write or
        // paint that it describes, and it carries no user or message content.
        if (response.statusCode === 401 || response.statusCode === 403) return;
        const duration = Math.min(600_000, Math.round(performance.now() - started));
        void recordOperatorFunctionEvent(
          options.database,
          observedFunction,
          duration,
          response.statusCode >= 400,
        ).catch(() => undefined);
      });
    }
    console.log('[req]', method, url.pathname);
    const minimum = helperVersionGate.minimum;
    const reportedVersion = request.headers['x-beeline-helper-version'];
    if (
      minimum &&
      method === 'POST' &&
      url.pathname.startsWith('/v1/daemon/') &&
      helperVersionBelowMinimum(
        typeof reportedVersion === 'string' ? reportedVersion : undefined,
        minimum,
      )
    ) {
      liveCounters.helperVersionRefusals++;
      json(response, 426, { error: 'update_required', minVersion: minimum });
      return;
    }
    if (url.pathname !== '/v1/site/download-tap' && isWebAppCorsPath(url.pathname) && applyWebAppCors(request, response, options)) return;
    if (url.pathname === '/v1/vault-save/submit' || url.pathname === '/v1/vault-save/answer') {
      void vaultSaveHttp(request, response, options, vaultSaveRelay);
      return;
    }
    void route(
      request,
      response,
      options,
      invitePreview,
      liveHealth,
      helperVersionGate,
      httpPhoneOperation,
    ).catch((error) => {
      const message = error instanceof Error ? error.message : 'request failed';
      const status = requestErrorStatus(error);
      if (error instanceof GitHubHttpError && error.rateLimited && error.retryAfter)
        response.setHeader('retry-after', error.retryAfter);
      // A failing Telegram delivery must not create another alert to itself.
      if (status >= 500 && !['/api/webhooks/sentry', '/v1/sentry/webhook'].includes(url.pathname)) captureServerError(error);
      console.error(
        '[req-error]',
        method,
        url.pathname,
        `status=${status}`,
        error instanceof Error ? error.stack || error.message : String(error),
      );
      json(response, status, error instanceof PhoneOperationError ? error.payload : { error: message });
    });
  });
  // HTTP `close` waits for upgraded sockets. Terminate them before starting
  // that wait, otherwise an idle daemon subscription can hold shutdown open.
  const closeHttp = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => {
    // Connections stay held across a restart: helpers reconnect to a running
    // instance, and this instance's lease releases whatever never returns.
    shuttingDown = true;
    releaseConnectionEpochs?.();
    for (const client of webSockets.clients) client.terminate();
    webSockets.close();
    return closeHttp((error) => {
      void phoneViewing.endAll().then(
        () => callback?.(error),
        (releaseError: unknown) => {
          console.error('[live] viewing shutdown release failed', releaseError);
          callback?.(error ?? (releaseError instanceof Error ? releaseError : new Error(String(releaseError))));
        },
      );
    });
  }) as Server['close'];
  server.on('upgrade', (request, socket, head) => {
    if (gameOrigin && request.headers.host === new URL(gameOrigin).host) {
      socket.destroy();
      return;
    }
    void (async () => {
      const url = exactPath(request.url);
      const computer = /^\/s\/([A-Za-z0-9_-]{43})\/(?:ws|stream)$/.exec(url.pathname);
      if (computer) {
        await upgradeComputerSession(request, socket, head, options.database, options.live, computer[1]!);
        return;
      }
      const computerSource = /^\/s\/([A-Za-z0-9_-]{43})\/source$/.exec(url.pathname);
      if (computerSource) {
        const token = bearer(request.headers.authorization);
        const agentId = token ? await options.auth.authenticateDaemon(token) : null;
        if (!agentId) { socket.destroy(); return; }
        await upgradeBodyComputerSource(request, socket, head, options.database, options.live, computerSource[1]!, agentId);
        return;
      }
      const computerWait = /^\/s\/([A-Za-z0-9_-]{43})\/wait$/.exec(url.pathname);
      if (computerWait) {
        const token = bearer(request.headers.authorization);
        const agentId = token ? await options.auth.authenticateDaemon(token) : null;
        if (!agentId) { socket.destroy(); return; }
        const since = Math.max(0, Number(url.searchParams.get('since') ?? 0) || 0);
        await upgradeComputerWaiter(request, socket, head, options.database, computerWait[1]!, agentId, since);
        return;
      }
      if (url.pathname !== '/v1/phone/live') {
        socket.destroy();
        return;
      }
      const raw = tokenFromProtocol(request);
      const helperVersion = url.searchParams.get('helperVersion') ?? undefined;
      const helperSourceSha = url.searchParams.get('sourceSha') ?? undefined;
      const minimum = helperVersionGate.minimum;
      const machine = isMachineSocket(request);
      if (
        (machine || raw?.startsWith('bdt_')) &&
        minimum &&
        helperVersionBelowMinimum(helperVersion, minimum)
      ) {
        liveCounters.helperVersionRefusals++;
        const payload = JSON.stringify({ error: 'update_required', minVersion: minimum });
        socket.write(
          `HTTP/1.1 426 Upgrade Required\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`,
        );
        socket.destroy();
        return;
      }
      if (machine) {
        // Identity arrives per agent after the upgrade; bound the anonymous
        // sockets one client address can hold open meanwhile.
        const key = clientKey(request);
        const open = machineSocketCounts.get(key) ?? 0;
        if (open >= MAX_MACHINE_SOCKETS_PER_CLIENT) {
          liveErrors.overload++;
          socket.write('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\n\r\n');
          socket.destroy();
          return;
        }
        machineSocketCounts.set(key, open + 1);
        socket.once('close', () => {
          const remaining = (machineSocketCounts.get(key) ?? 1) - 1;
          if (remaining <= 0) machineSocketCounts.delete(key);
          else machineSocketCounts.set(key, remaining);
        });
        webSockets.handleUpgrade(request, socket, head, (client) =>
          webSockets.emit('connection', client, request, {
            identityId: '',
            kind: 'machine',
            helperVersion,
            helperSourceSha,
          }),
        );
        return;
      }
      // Daemon tokens have a distinct prefix. Avoid making every phone socket
      // pay for a failed daemon-auth query before its ordinary session lookup.
      const daemonId = raw?.startsWith('bdt_') ? await options.auth.authenticateDaemon(raw) : null;
      const phoneSession =
        !daemonId && raw && !raw.startsWith('bdt_') ? await readPhoneSession(options.auth, raw) : null;
      const phoneId = phoneSession?.identityId ?? null;
      const identityId = daemonId ?? phoneId;
      if (!identityId) {
        const payload = JSON.stringify({ error: 'phone_token_required' });
        socket.write(`HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`);
        socket.destroy();
        return;
      }
      // Newest socket wins. A helper holds one live socket, so an older one
      // for the same agent belongs to a dead process or a dead network path.
      // Its count is released now, not on its eventual close, so zombies can
      // never hold the cap against the helper that replaced them.
      if (daemonId) {
        for (const older of [...(daemonSockets.get(daemonId) ?? [])]) {
          older.release();
          older.socket.destroy();
        }
      }
      const openSockets = socketCounts.get(identityId) ?? 0;
      if (openSockets >= (daemonId ? 4 : 8)) {
        liveErrors.overload++;
        socket.write('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\n\r\n');
        socket.destroy();
        return;
      }
      socketCounts.set(identityId, openSockets + 1);
      let released = false;
      const admitted = {
        socket,
        release: () => {
          if (released) return;
          released = true;
          const remaining = socketCounts.get(identityId) ?? 1;
          if (remaining <= 1) socketCounts.delete(identityId);
          else socketCounts.set(identityId, remaining - 1);
          const agentSockets = daemonSockets.get(identityId);
          agentSockets?.delete(admitted);
          if (agentSockets?.size === 0) daemonSockets.delete(identityId);
        },
      };
      if (daemonId) {
        const agentSockets = daemonSockets.get(daemonId) ?? new Set();
        agentSockets.add(admitted);
        daemonSockets.set(daemonId, agentSockets);
      }
      socket.once('close', admitted.release);
      webSockets.handleUpgrade(request, socket, head, (client) =>
        webSockets.emit('connection', client, request, {
          identityId,
          kind: daemonId ? 'daemon' : 'phone',
          helperVersion,
          helperSourceSha,
          ...(phoneSession?.familyId ? { familyId: phoneSession.familyId } : {}),
        }),
      );
    })().catch(() => socket.destroy());
  });
  webSockets.on(
    'connection',
    (
      client: WebSocket,
      _request: IncomingMessage,
      principal: {
        identityId: string;
        kind: 'phone' | 'daemon' | 'machine';
        helperVersion?: string;
        helperSourceSha?: string;
        familyId?: string;
      },
    ) => {
return handleLiveConnection({ liveErrors, watchConnectionEpochs, socketSubscriptions, daemonLive, options, readNeedsYouForViewer, readLiveRowForViewer, readWorkspaceChange, readPersonChange, bookmarkReads, withLiveDbTask, dispatchPhoneOperation, readCornerStatusForViewer, phoneViewing, acquireLiveDbTask }, client, _request, principal);
},
  );
  server.once('listening', () => { void options.daemon.warmConnectorIndex?.(); });
  return server;
}
