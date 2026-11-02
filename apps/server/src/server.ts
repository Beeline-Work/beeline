import { owedMentions } from './owed-mentions.js';
import { serveEmailImage } from './email-images.js';
import { createPhoneOperationDispatcher, PhoneOperationError, type PhoneOperationDispatcher } from './phone-operations.js';
import { phoneSocketRequests } from './phone-socket.js';
import { PHONE_SOCKET_MAX_FRAME_BYTES } from '@beeline/api-contract/phone';
import { parseMobileMinimum } from '@beeline/api-contract/mobile-minimum';
import { readMobileMinimums, writeMobileMinimum } from './mobile-minimum.js';
import { parseSiteDownloadTap, recordSiteDownloadTap } from './site-download-taps.js';
import { VaultSaveRelay } from './vault-save-relay.js';
import { vaultSaveHttp } from './vault-save-http.js';
import type { RoomsMcp } from './rooms-mcp.js';
import { ingestScreenReport, parseScreenReport } from './x-ad-screen.js';
import { parseSigninFunnelEvent } from '@beeline/api-contract/signin-funnel';
import { FunnelRateLimit, recordSigninFunnelEvent } from './signin-funnel.js';
import { runnableOrigin, serveRunnableArtifact } from './runnable-artifact.js';
import { readCompanyLogo } from './company-logos.js';
import { captureServerError } from './sentry.js';
import { receiveSentryWake } from './sentry-wake.js';
import { authenticSentryAlert, sendSentryTelegram, sentryTelegramMessage, type SentryTelegramConfig } from './sentry-telegram.js';
import { verifyNip98Header } from '@beeline/nostr';
import { WorkflowAuthorizationError } from './workflow-admin.js';
import { WorkspaceSkillNotFoundError } from './institutional-skills.js';
import { GitHubHttpError } from '@beeline/auth/github';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { serveComputerSession, serveComputerStatus, upgradeBodyComputerSource, upgradeComputerSession, upgradeComputerWaiter } from './computer-session.js';
import type { Duplex } from 'node:stream';
import { isTransientDatabaseConnectionError, type SqlDatabase } from './database.js';
import { DurableLiveReplay, readLiveCursor } from './durable-live.js';
import type { FreeAgentService } from './free-agents.js';
import { handleFreeAgentModelRequest, type FreeAgentModelProxyOptions } from './free-agent-model-proxy.js';
import { isAppSignInLink } from './composio-apps.js';
import type { ComposioApps } from './composio-apps.js';
import { ingestComposioDelivery } from './composio-delivery.js';
import { ingestSubscriptionWebhook, WEBHOOK_BODY_LIMIT } from './subscription-webhooks.js';
import { ingestProviderWebhook } from './provider-webhooks.js';
import { ingestWalletWebhook } from './wallet-webhooks.js';
import { acceptedJsonEncoding, encodeJsonBody, type JsonEncoding } from './json-response.js';
import { PhoneViewing } from './phone-viewing.js';
import {
  COMPACT_VIEW_HEADER,
  compactRoomHistoryView,
  compactRoomView,
  wantsCompactView,
} from './compact-room-view.js';
import { bearer, GoogleSignInError, type TokenAuth } from './auth.js';
import {
  AGENT_OWNER_AUTHORITY_MESSAGE,
  WORKSPACE_ADMIN_AUTHORITY_MESSAGE,
  SPENDING_OWNER_AUTHORITY_MESSAGE,
  CONNECTOR_OFFER_AUTHORITY_MESSAGE,
  CONNECTOR_OFFER_WALLET_AUTHORITY_MESSAGE,
  YOLO_AUTHORITY_MESSAGE,
  type PhoneService,
} from './phone-service.js';
import { DAEMON_OPERATION_NAMES, type DaemonService } from './daemon-service.js';
import { CommandRefusalError } from './commander.js';
import { institutionalMemoryErrorStatus } from './institutional-memory-shadow.js';
import { ARTIFACT_MAXIMUM_BYTES, decodeArtifactTitleHeader } from '@beeline/api-contract/daemon';
import {
  projectSidebarPreview,
  offscreenMessageFits,
  readSidebarPreview,
  type MessageBookmarkView,
  type RoomHistoryView,
  type RoomLiveDelta,
} from '@beeline/api-contract/phone';
import type { LiveEvent, LiveHub, LiveTrace } from './live.js';
import { isNeedsYouAsk } from './needs-you.js';
import type { ReviewAccess } from './review-access.js';
import type { ReleaseNotifier } from './release-notify.js';
import { TRANSCRIPTION_MAXIMUM_BYTES, type SpeechTranscriber } from './speech-transcription.js';
import type { VoiceService } from './voice-service.js';
import { isMediaId } from './media-ttl.js';
import type { ObjectService } from './object-service.js';
import { connectorLogo } from './workbench.js';
import type { LinkAgentWallet } from './link-agent-wallet.js';
import type { RegistryMcpOAuth } from './registry-mcp-oauth.js';
import { InvitePreviewAccess } from './invite-preview.js';
import { phoneReadLimits, type PhoneReadLimits } from './phone-read-limit.js';
import type { ConnectionPresence } from './connection-presence.js';
import {
  parseDashboardPlatforms,
  readOperatorDashboard,
  recordOperatorFunctionEvent,
} from './operator-dashboard.js';
import { HelperVersionGate, helperVersionBelowMinimum } from './helper-version-gate.js';
import {
  DaemonConnectionRegistry,
  LIVE_HEARTBEAT_MS,
  MACHINE_SOCKET_PROTOCOL,
  MAX_LIVE_SUBSCRIBE_FRAME_ROOMS,
  serveAgentSocket,
  serveMachineSocket,
  type DaemonLiveDependencies,
} from './daemon-live.js';

export const DEFAULT_MEDIA_MAXIMUM_BYTES = 25 * 1024 * 1024;

const MAX_JSON_BYTES = 1024 * 1024;
let webhookWritesSincePrune = 0;
// A reconnecting helper may send all of its Room subscriptions at once. Keep
// those reads outside pg-pool's queue, where they would otherwise time out and
// amplify the reconnect. Older helpers need no new protocol to use this gate.
// The gate scales with the machine's app pool and leaves four of its
// connections to ordinary requests, so live work never takes all of them.
const MIN_LIVE_DB_TASKS = 2;
const LIVE_DB_RESERVED_APP_CONNECTIONS = 4;
export function maxLiveDbTasks(appConnections: number | undefined): number {
  return Math.max(MIN_LIVE_DB_TASKS, (appConnections ?? 0) - LIVE_DB_RESERVED_APP_CONNECTIONS);
}
const MAX_LIVE_WAITING_TASKS = 512;
const MAX_LIVE_SOCKET_TASKS = 8_192;
const MAX_LIVE_SOCKET_QUEUED_BYTES = 2 * 1024 * 1024;
const MAX_LIVE_ROOMS_PER_SOCKET = 8_192;
const MAX_LIVE_OUTBOUND_BUFFERED_BYTES = 16 * 1024 * 1024;
/** Rows one socket remembers for `admitRow`; rows with a read in flight stay. */
const SENT_ROW_LIMIT = 256;
/** A message's version, or the live epoch and sequence a corner status was read for. */
type RowOrder = { version: number } | { epoch?: string; sequence: number };
type SentRow = { order?: RowOrder; fingerprint?: string; reads: number };

/** Whether `next` is not newer than the frame already sent; unordered frames always are newer. */
function rowOrderIsNotNewer(next: RowOrder | undefined, sent: RowOrder | undefined): boolean {
  if (!next || !sent) return false;
  if ('version' in next) return 'version' in sent && next.version <= sent.version;
  return !('version' in sent) && next.epoch === sent.epoch && next.sequence <= sent.sequence;
}
const LIVE_PING_FRAME = JSON.stringify({ type: 'ping' });
const LIVE_PONG_FRAME = JSON.stringify({ type: 'pong' });
const ROOM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Machine sockets authenticate per agent after upgrade; cap them per client address. */
const MAX_MACHINE_SOCKETS_PER_CLIENT = 8;
export interface GitHubServerHooks {
  webhookSecret?: string;
  roomToken?: (identityId: string, roomId: string) => Promise<{ token: string; expiresAt: number }>;
  onWebhook?: (eventType: string, payload: unknown, deliveryId?: string) => Promise<void>;
  completeInstallation?: (state: string, installationId: number) => Promise<string>;
}

export interface ServerOptions {
  replay?: DurableLiveReplay;
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
  /** Per-identity limits on phone history and outline reads; defaults in phone-read-limit.ts. */
  phoneReadLimits?: PhoneReadLimits;
  /** Protocol ping interval for helper sockets; tests shorten it. */
  liveHeartbeatMs?: number;
}

const appSignInReturnCookie = 'beeline_app_sign_in_return';

/** The configured web origin this browser started app sign-in from, if any. */
function appSignInWebOrigin(request: IncomingMessage, options: ServerOptions): string | undefined {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name !== appSignInReturnCookie) continue;
    let origin: string;
    try { origin = decodeURIComponent(value.join('=')); } catch { return undefined; }
    return options.webAppOrigins?.includes(origin) ? origin : undefined;
  }
  return undefined;
}

function applyWebAppCors(
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

function isWebAppCorsPath(pathname: string): boolean {
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
const jsonEncodings = new WeakMap<ServerResponse, JsonEncoding>();
const roomRequestStartedAt = new WeakMap<ServerResponse, number>();

function json(response: ServerResponse, status: number, body: unknown): void {
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
const funnelRateLimit = new FunnelRateLimit();
async function body(request: IncomingMessage, allowEmptyVoiceBody = false): Promise<Record<string, unknown>> {
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
function isMachineSocket(request: IncomingMessage): boolean {
  const protocol = request.headers['sec-websocket-protocol'];
  return (
    typeof protocol === 'string' &&
    protocol.split(',').some((item) => item.trim() === MACHINE_SOCKET_PROTOCOL)
  );
}
function isRetryableLiveError(error: unknown): boolean {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return isTransientDatabaseConnectionError(error) || code === '57014' || code === '53300';
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
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: PHONE_SOCKET_MAX_FRAME_BYTES });
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
  // Protocol-level heartbeat for every helper socket. A ping is a control
  // frame: no database work, no read, no Room event. A socket that has not
  // answered the previous ping by the next tick is dead and is terminated;
  // the helper drops a socket that stops pinging it and reconnects.
  const heartbeatMs = options.liveHeartbeatMs ?? LIVE_HEARTBEAT_MS;
  const heartbeatSockets = new Map<WebSocket, boolean>();
  const intakeCheckpoints = new Map<WebSocket, () => void>();
  const heartbeat = setInterval(() => {
    for (const [client, answered] of heartbeatSockets) {
      if (!answered) {
        liveCounters.heartbeatTerminations++;
        heartbeatSockets.delete(client);
        intakeCheckpoints.delete(client);
        client.terminate();
        continue;
      }
      heartbeatSockets.set(client, false);
      try {
        client.ping();
        intakeCheckpoints.get(client)?.();
      } catch {
        // A socket that cannot queue a ping misses the next tick.
      }
    }
  }, heartbeatMs);
  heartbeat.unref?.();
  const invitePreview = new InvitePreviewAccess(options.database);
  const phoneViewing = new PhoneViewing(options.database, options.connectionPresence?.instanceId ?? randomUUID());
  const readLimits = options.phoneReadLimits ?? phoneReadLimits();
  const dispatchPhoneOperation = createPhoneOperationDispatcher(options, readLimits, options.phone.execute);
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
        : method === 'POST' &&
            /^\/v1\/phone\/operations\/(sendRoomMessage|sendRoomReply)$/.test(url.pathname)
          ? 'message_delivery'
          : method === 'POST' &&
              (url.pathname === '/v1/phone/operations/createHumanCorner' ||
                url.pathname === '/v1/daemon/operations/createCorner')
            ? 'corner_open'
            : null;
    if (observedFunction) {
      const started = performance.now();
      response.once('finish', () => {
        // The observation is after the response. It cannot delay the write or
        // paint that it describes, and it carries no user or message content.
        if (response.statusCode === 401 || response.statusCode === 403) return;
        // Successful messages are observed when an actual subscribed phone
        // acknowledges paint below. A failed write has no paint to await.
        if (observedFunction === 'message_delivery' && response.statusCode < 400) return;
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
      dispatchPhoneOperation,
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
    clearInterval(heartbeat);
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
      const sendLive = (payload: string) => {
        if (client.readyState !== client.OPEN) return;
        if (client.bufferedAmount + Buffer.byteLength(payload) > MAX_LIVE_OUTBOUND_BUFFERED_BYTES) {
          liveErrors.overload++;
          client.close(1013, 'live backpressure');
          return;
        }
        client.send(payload);
      };
      if (principal.kind !== 'phone') {
        watchConnectionEpochs();
        heartbeatSockets.set(client, true);
        client.on('pong', () => {
          if (heartbeatSockets.has(client)) heartbeatSockets.set(client, true);
        });
        const trackSubscriptions = (count: () => number) => socketSubscriptions.set(client, count);
        client.on('close', () => {
          heartbeatSockets.delete(client);
          intakeCheckpoints.delete(client);
          socketSubscriptions.delete(client);
        });
        if (principal.kind === 'machine')
          serveMachineSocket(
            daemonLive,
            client,
            principal,
            sendLive,
            trackSubscriptions,
            heartbeatMs,
            checkpoint => intakeCheckpoints.set(client, checkpoint),
          );
        else serveAgentSocket(daemonLive, client, principal, sendLive, trackSubscriptions);
        return;
      }
      options.live.humanConnected(principal.identityId);
      // Rooms this socket views hold pushes until it says otherwise or closes.
      const viewingSession = randomUUID();
      const viewedRooms = new Set<string>();
      const previewRooms = new Set<string>();
      const releases = new Map<string, () => void>();
      const workspaceReleases = new Map<string, () => void>();
      let phoneViewClosed = false;
      // Workspace membership notifications survive the deletion cascade and
      // reach the affected identity without requiring a readable Room.
      let needsYouDelivery = Promise.resolve();
      // Workspace and identity changes keep their commit order on this socket.
      let identityDelivery = Promise.resolve();
      const sendNeedsYouDelta = (event: LiveEvent, roomId: string) => {
        if (!options.phone.liveNeedsYou) return;
        // A later projection must not overtake an earlier one and then be
        // overwritten by its stale count or slice on the same socket.
        needsYouDelivery = needsYouDelivery.then(() =>
          readNeedsYouForViewer(event, roomId, principal.identityId).then((value) => {
            if (!value) return;
            sendLive(JSON.stringify({ type: 'needs-you-delta', roomId: '',
              sourceRoomId: roomId, ...value }));
          })).catch(() => sendLive(JSON.stringify({ type: 'invalidate', roomId: '',
          reason: 'needs-you-gap' })));
      };
      const releaseWorkspaces = options.live.subscribeAll((event) => {
        if (event.type === 'resource-change') {
          if (event.ownerId === principal.identityId)
            sendLive(JSON.stringify({ type: 'resource-change', roomId: '',
              resource: event.resource, ...(event.resourceId ? { resourceId: event.resourceId } : {}),
              ...(event.version ? { version: event.version } : {}) }));
          return;
        }
        if (event.type !== 'invalidate') return;
        if (event.roomId !== '') {
          if (releases.has(event.roomId)) return;
          if (!event.messageId || !options.phone.liveNeedsYou) return;
          const local = event.committedRow?.type === 'message' ? event.committedRow.row : null;
          const candidate = event.needsYouCandidate || event.reason === 'phone-write' ||
            event.agentId === principal.identityId ||
            (local && (local.presentation === 'card' || local.presentation === 'system' ||
              isNeedsYouAsk(local.text)));
          if (!candidate) return;
          void readLiveRowForViewer(event, event.roomId, principal.identityId,
            { type: 'message', messageId: event.messageId }).then((delta) => {
            if (delta?.type !== 'message-delta') return;
            const message = delta.message;
            if (message.author.pubkey === principal.identityId ||
                message.presentation === 'card' || message.presentation === 'system' ||
                (message.mentionPubkeys?.includes(principal.identityId) &&
                  isNeedsYouAsk(message.text))) sendNeedsYouDelta(event, event.roomId);
          }).catch(() => undefined);
          return;
        }
        if (event.reason === 'postgres:workspaces' && event.workspaceId) {
          const read = readWorkspaceChange(event, event.workspaceId);
          identityDelivery = identityDelivery.then(() => read.then((change) => {
            if (!change?.viewers.has(principal.identityId)) return;
            sendLive(JSON.stringify({ type: 'workspace-changed', roomId: '',
              workspace: change.workspace }));
          })).catch(() => undefined);
          return;
        }
        if (event.reason === 'postgres:identities' && event.personId) {
          // A push level change alone carries its owner as the only reader.
          if (event.readerId && event.readerId !== principal.identityId) return;
          const read = readPersonChange(event, event.personId);
          identityDelivery = identityDelivery.then(() => read.then((change) => {
            if (!change?.viewers.has(principal.identityId)) return;
            // The push level is the owner's own setting; no other viewer hears it.
            sendLive(JSON.stringify({ type: 'person-changed', roomId: '', person: change.person,
              ...(change.person.pubkey === principal.identityId && change.pushLevel
                ? { pushLevel: change.pushLevel } : {}) }));
          })).catch(() => undefined);
          return;
        }
        if (event.readerId !== principal.identityId) return;
        if (event.reason === 'postgres:memberships') {
          sendLive(JSON.stringify({ type: 'invalidate', roomId: '', reason: event.reason }));
          return;
        }
        if (event.reason === 'postgres:needs_you_marks' && event.sourceRoomId) {
          sendNeedsYouDelta(event, event.sourceRoomId);
          return;
        }
        if (event.reason !== 'postgres:message_bookmarks' || !event.messageId ||
            !event.workspaceId || !options.phone.readLiveBookmark) return;
        let read = bookmarkReads.get(event);
        if (!read) {
          read = (event.operation === 'DELETE'
            ? Promise.resolve(null)
            : withLiveDbTask(() => options.phone.readLiveBookmark(
              event.messageId!, principal.identityId)))
            .finally(() => bookmarkReads.delete(event));
          bookmarkReads.set(event, read);
        }
        void read.then((bookmark) => {
          sendLive(JSON.stringify({ type: 'bookmark-delta', roomId: '',
            workspaceId: event.workspaceId, messageId: event.messageId, bookmark }));
        }).catch(() => sendLive(JSON.stringify({ type: 'invalidate', roomId: '',
          reason: 'bookmark-gap' })));
      });
      const releasePersonalResync = options.live.subscribeResync(() => {
        if (client.readyState === client.OPEN)
          sendLive(JSON.stringify({ type: 'invalidate', roomId: '', reason: 'reconnect' }));
      });
      // The socket is an ordered stream. Keep the last text handed to this
      // reader so duplicate local/PG publications cost no wire bytes, and a
      // growing draft carries only its new suffix. A new subscription starts
      // with a full snapshot below.
      const draftWire = new Map<string, { text: string; revision: number }>();
      // Keep in-flight rows while ordering and deduplicating delivered projections.
      const sentRows = new Map<string, SentRow>();
      const beginRowRead = (key: string) => {
        const row = sentRows.get(key) ?? { reads: 0 };
        row.reads += 1;
        sentRows.set(key, row);
      };
      const endRowRead = (key: string) => {
        const row = sentRows.get(key);
        if (!row) return;
        row.reads -= 1;
        if (!row.reads && row.fingerprint === undefined) sentRows.delete(key);
      };
      const admitRow = (key: string, order: RowOrder | undefined, fingerprint: string) => {
        const sent = sentRows.get(key) ?? { reads: 0 };
        if (rowOrderIsNotNewer(order, sent.order)) return false;
        // An unchanged projection is not sent, but its order still advances,
        // so an older frame with other content cannot follow it.
        sentRows.delete(key);
        sentRows.set(key, { order: order ?? sent.order, fingerprint, reads: sent.reads });
        for (const [candidate, row] of sentRows) {
          if (sentRows.size <= SENT_ROW_LIMIT) break;
          if (!row.reads) sentRows.delete(candidate);
        }
        return sent.fingerprint !== fingerprint ||
          (order !== undefined && 'sequence' in order &&
            (sent.order === undefined || !('sequence' in sent.order) || order.epoch !== sent.order.epoch));
      };
      const sendDraft = (event: Extract<LiveEvent, { type: 'draft' | 'thought' }>,
        sequence?: number, epoch?: string) => {
        const key = `${event.roomId}:${event.agentId}:${event.turnId}:${event.type}`;
        const previous = draftWire.get(key);
        if (previous?.text === event.text) return;
        if (previous && event.text.startsWith(previous.text)) {
          const revision = previous.revision + 1;
          const chunk = event.text.slice(previous.text.length);
          draftWire.set(key, { text: event.text, revision });
          sendLive(JSON.stringify({
            type: `${event.type}-append`, roomId: event.roomId,
            agentId: event.agentId, turnId: event.turnId,
            revision, offset: previous.text.length,
            chunk,
            ...(sequence !== undefined ? { sequence } : {}),
            ...(epoch !== undefined ? { epoch } : {}),
            ...(event.latestChunk !== undefined && event.latestChunk !== chunk
              ? { latestChunk: event.latestChunk } : {}),
          }));
          return;
        }
        draftWire.set(key, { text: event.text, revision: 0 });
        sendLive(JSON.stringify({ ...event, revision: 0,
          ...(sequence !== undefined ? { sequence } : {}),
          ...(epoch !== undefined ? { epoch } : {}) }));
      };
      socketSubscriptions.set(client, () => releases.size);
      let socketTasks = 0;
      let socketQueuedBytes = 0;
      let socketTaskTail = Promise.resolve();
      const pendingPaintTraces = new Map<
        string,
        {
          readonly startedAt?: number;
          readonly databaseAt: number;
          readonly databaseClock: boolean;
          readonly kind: 'message' | 'turn';
        }
      >();
      const rememberPaintTrace = (trace: LiveTrace | undefined, kind: 'message' | 'turn') => {
        if (!trace || (typeof trace.startedAt !== 'number' && trace.paintAck !== 'database-clock'))
          return;
        pendingPaintTraces.set(trace.id, {
          startedAt: trace.startedAt,
          databaseAt: trace.databaseAt,
          databaseClock: trace.paintAck === 'database-clock',
          kind,
        });
        if (pendingPaintTraces.size > 64) {
          const oldest = pendingPaintTraces.keys().next().value;
          if (oldest) pendingPaintTraces.delete(oldest);
        }
      };
      const handlePhoneRequest = phoneSocketRequests(client, principal.identityId,
        dispatchPhoneOperation, sendLive, requestErrorStatus, principal.familyId);
      client.on('message', (raw) => {
        const frameBytes = Array.isArray(raw)
          ? raw.reduce((total, part) => total + part.length, 0)
          : raw.byteLength;
        // The phone's liveness ping needs no database work, so it never
        // waits behind the admission queue.
        if (frameBytes <= 32 && raw.toString() === LIVE_PING_FRAME) {
          sendLive(LIVE_PONG_FRAME);
          return;
        }
        if (frameBytes <= 32 && raw.toString() === '{"type":"sync"}') {
          sendLive('{"type":"sync-ok"}');
          return;
        }
        try {
          if (handlePhoneRequest(JSON.parse(raw.toString()))) return;
        } catch {
          liveErrors.invalid++;
          return;
        }
        if (
          socketTasks >= MAX_LIVE_SOCKET_TASKS ||
          socketQueuedBytes + frameBytes > MAX_LIVE_SOCKET_QUEUED_BYTES
        ) {
          liveErrors.overload++;
          client.close(1013, 'live admission overloaded');
          return;
        }
        socketTasks++;
        socketQueuedBytes += frameBytes;
        const processMessage = async () => {
          if (client.readyState !== client.OPEN) return;
          let message: unknown;
          try {
            message = JSON.parse(raw.toString());
          } catch {
            liveErrors.invalid++;
            return;
          }
          if (!message || typeof message !== 'object') return;
          const item = message as Record<string, unknown>;
          if (item.type === 'sync' && options.replay) {
            const workspaces = await options.database.query<{ workspace_id: string }>(
              `SELECT workspace_id FROM memberships WHERE identity_id=$1
               AND room_id IS NULL AND removed_at IS NULL`, [principal.identityId]);
            const cursors = item.workspaceCursors && typeof item.workspaceCursors === 'object'
              ? item.workspaceCursors as Record<string, unknown> : {};
            const currentWorkspaces = new Set(workspaces.rows.map(row => row.workspace_id));
            for (const workspaceId of Object.keys(cursors)) {
              if (!currentWorkspaces.has(workspaceId)) {
                workspaceReleases.get(workspaceId)?.();
                workspaceReleases.delete(workspaceId);
                sendLive(JSON.stringify({ type: 'workspace-cursor', roomId: '',
                  workspaceId, sequence: 0, epoch: '', reload: true }));
              }
            }
            for (const { workspace_id: workspaceId } of workspaces.rows) {
              if (workspaceReleases.has(workspaceId)) continue;
              const cursor = readLiveCursor(cursors[workspaceId]);
              const checkpoint = (sequence: number, epoch: string, reload: boolean) => {
                sendLive(JSON.stringify({ type: 'workspace-cursor', roomId: '',
                  workspaceId, sequence, epoch, reload }));
                if (!epoch) client.close(1013, 'live replay unavailable');
              };
              const subscription = await options.replay.subscribe(
                `workspace:${workspaceId}`, '', cursor,
                (event, sequence, epoch) => {
                  if (event.type === 'invalidate' && event.sourceRoomId && releases.has(event.sourceRoomId)) return;
                  sendLive(JSON.stringify({ type: 'invalidate', roomId: '',
                    reason: 'workspace-replay', workspaceId, sequence, epoch }));
                }, checkpoint, async () => (await options.database.query(
                  `SELECT 1 FROM memberships WHERE workspace_id=$1 AND identity_id=$2
                   AND room_id IS NULL AND removed_at IS NULL`, [workspaceId, principal.identityId])).rowCount > 0);
              if (client.readyState !== client.OPEN) { subscription.release(); return; }
              workspaceReleases.set(workspaceId, subscription.release);
              checkpoint(subscription.resumed ? cursor!.base : subscription.sequence,
                subscription.epoch, !subscription.resumed);
              for (const entry of subscription.replay) {
                if (entry.event.type === 'invalidate' && entry.event.sourceRoomId &&
                    releases.has(entry.event.sourceRoomId)) continue;
                sendLive(JSON.stringify({ type: 'invalidate', roomId: '', reason: 'workspace-replay',
                  workspaceId, sequence: entry.sequence, epoch: subscription.epoch }));
              }
              if (subscription.resumed) checkpoint(subscription.sequence, subscription.epoch, false);
              subscription.start();
            }
            sendLive('{"type":"sync-ok"}');
            return;
          }
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
              sendLive(
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
            if (
              trace.kind === 'message' &&
              serverReceivedAt >= trace.startedAt &&
              serverReceivedAt - trace.startedAt <= 600_000
            ) {
              void recordOperatorFunctionEvent(
                options.database,
                'message_delivery',
                serverReceivedAt - trace.startedAt,
                false,
              ).catch(() => undefined);
            }
            sendLive(
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
          if (item.type === 'subscribe') {
            const requestedRoomIds = Array.isArray(item.roomIds)
              ? [
                  ...new Set(
                    (item.roomIds as unknown[]).filter(
                      (id): id is string => typeof id === 'string' && id.length > 0,
                    ),
                  ),
                ]
              : typeof item.roomId === 'string'
                ? [item.roomId]
                : [];
            if (requestedRoomIds.length === 0) return;
            if (
              requestedRoomIds.length > MAX_LIVE_SUBSCRIBE_FRAME_ROOMS ||
              releases.size + requestedRoomIds.filter((id) => !releases.has(id)).length >
                MAX_LIVE_ROOMS_PER_SOCKET
            ) {
              liveErrors.invalid++;
              client.close(1008, 'live subscription limit');
              return;
            }
            const readableRooms = await options.phone.canReadRooms(
              requestedRoomIds,
              principal.identityId,
            );
            for (const roomId of requestedRoomIds) {
              if (!readableRooms.has(roomId) || releases.has(roomId)) continue;
              if (item.sidebarPreviews === true) previewRooms.add(roomId);
              // Agents whose draft this socket has already been handed live.
              // The snapshot below is read asynchronously, so a delta can land
              // first; replacing it with the older row would show the reader the
              // answer going backwards.
              const streamed = new Set<string>();
              const candidateCursor = (item.cursors && typeof item.cursors === 'object' &&
                !Array.isArray(item.cursors)
                ? (item.cursors as Record<string, unknown>)[roomId] : undefined);
              const cursor = candidateCursor && typeof candidateCursor === 'object' &&
                !Array.isArray(candidateCursor) ? candidateCursor as Record<string, unknown> : undefined;
              const resume = cursor && typeof cursor.epoch === 'string' &&
                typeof cursor.base === 'number' && Array.isArray(cursor.seen)
                ? { epoch: cursor.epoch, base: cursor.base,
                    seen: cursor.seen.filter((value): value is number => typeof value === 'number') }
                : undefined;
              let latestEpoch: string | undefined;
              const forwardEvent = (event: LiveEvent, sequence?: number, epoch?: string) => {
                  if (epoch !== undefined) latestEpoch = epoch;
                  const currentEpoch = () => epoch === undefined || epoch === latestEpoch;
                  const sendFrame = (payload: Record<string, unknown>) => currentEpoch() && sendLive(JSON.stringify({
                    ...payload, ...(sequence !== undefined ? { sequence } : {}),
                    ...(epoch !== undefined ? { epoch } : {}),
                  }));
                  if (
                    event.type === 'invalidate' &&
                    event.readerId &&
                    event.readerId !== principal.identityId
                  )
                    return;
                  if (event.type === 'draft') streamed.add(event.agentId);
                  if (event.type !== 'invalidate') {
                    if (client.readyState !== client.OPEN) return;
                    if (event.type === 'draft' || event.type === 'thought') sendDraft(event, sequence, epoch);
                    else {
                      if (event.type === 'retract')
                        draftWire.delete(`${event.roomId}:${event.agentId}:${event.turnId}:${event.kind}`);
                      sendFrame(event);
                    }
                    return;
                  }
                  // committedRow is process-local authority input. Strip it
                  // before every wire branch, including malformed/no-target
                  // invalidations, so only a projected public delta can leave.
                  const { committedRow, trace: eventTrace } = event;
                  // Phone readers react to the reason and Room; the remaining
                  // LiveEvent fields route helper work or identify a row that
                  // will instead be sent as a projected delta below.
                  const wireEvent = { type: 'invalidate', roomId, reason: event.reason };
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
                    if (item.roomStateProjections === true && ((event.reason === 'postgres:room_read_marks' && event.readerId === principal.identityId &&
                          typeof options.phone.liveReadState === 'function') ||
                        (event.reason === 'postgres:agent_commands' && typeof options.phone.liveRoomCommands === 'function'))) {
                      const readMark = event.reason === 'postgres:room_read_marks';
                      const stateKey = `${roomId}:${readMark ? 'read-state' : 'room-commands'}`;
                      beginRowRead(stateKey);
                      return withLiveDbTask(async () => readMark
                        ? options.phone.liveReadState(roomId, principal.identityId)
                        : options.phone.liveRoomCommands(roomId, principal.identityId))
                        .then((state) => {
                          if (client.readyState !== client.OPEN || !currentEpoch()) return;
                          if (state === null) { sendFrame(wireEvent); return; }
                          if (!admitRow(stateKey, sequence !== undefined ? { epoch, sequence } : undefined,
                            JSON.stringify(state))) return;
                          sendFrame(readMark ? { type: 'read-state', roomId, readCursor: state }
                            : { type: 'room-commands', roomId, commands: state });
                        }).catch(() => { if (client.readyState === client.OPEN) sendFrame(wireEvent); })
                        .finally(() => endRowRead(stateKey));
                    }
                    if (event.reason === 'corner-status' &&
                        typeof options.phone.liveChatCornerStatus === 'function') {
                      const statusKey = `${roomId}:corner-status`;
                      beginRowRead(statusKey);
                      return readCornerStatusForViewer(event, roomId, principal.identityId)
                        .then((status) => {
                          if (client.readyState !== client.OPEN || !currentEpoch()) return;
                          if (!status) { sendFrame(wireEvent); return; }
                          if (!admitRow(statusKey,
                            sequence !== undefined ? { epoch, sequence } : undefined,
                            JSON.stringify(status))) return;
                          sendFrame({ type: 'corner-status', roomId, ...status });
                        })
                        .catch(() => {
                          if (client.readyState === client.OPEN) sendFrame(wireEvent);
                        })
                        .finally(() => endRowRead(statusKey));
                    }
                    if (client.readyState === client.OPEN)
                      sendFrame({ ...wireEvent,
                        ...(options.livePaintDiagnostics && eventTrace ? { trace: eventTrace } : {}) });
                    return;
                  }
                  const trace = options.livePaintDiagnostics ? eventTrace : undefined;
                  const wireTrace =
                    trace && options.livePaintDiagnostics && typeof trace.startedAt !== 'number'
                      ? ({ ...trace, paintAck: 'database-clock' as const } satisfies LiveTrace)
                      : trace;
                  const fallback = {
                    ...wireEvent,
                    ...(wireTrace ? { trace: wireTrace } : {}),
                    reason: `delta-fallback:${event.reason}`,
                  };
                  // Cross-process notifications carry only the committed row
                  // identity. Resolve every row independently: the result stays
                  // on the direct socket-delta path even when the app pool takes
                  // longer than an arbitrary UI deadline, and one slow/bad read
                  // cannot hold later committed messages behind it. The client
                  // reconciler restores causal order from createdAt/id.
                  // An internal row must agree with the Room-scoped bus key. A
                  // mismatch is neither serialized nor retried against attacker-
                  // controlled ids; the canonical PostgreSQL hint remains the
                  // independent recovery path for the real Room.
                  if (committedRow?.type === 'message' && committedRow.row.room_id !== roomId) return;
                  const rowKey = target.type === 'message'
                    ? `${roomId}:message:${target.messageId}`
                    : `${roomId}:turn:${target.agentId}:${target.requestId}`;
                  beginRowRead(rowKey);
                  const pendingDelta = (async () => committedRow?.type === 'message'
                    ? options.phone.projectCommittedLiveDelta(
                      roomId, committedRow, principal.identityId)
                    : readLiveRowForViewer(event, roomId, principal.identityId, target))().then(
                    (delta) => ({ delta }) as const,
                    (error: unknown) => ({ error }) as const,
                  );
                  return pendingDelta
                    .then(async (result) => {
                      if (client.readyState !== client.OPEN) return;
                      if ('error' in result) throw result.error;
                      if (!result.delta) {
                        sendFrame(fallback);
                        return;
                      }
                      let workflowRuns;
                      if (result.delta.type === 'message-delta' &&
                          result.delta.message.systemEvent?.kind === 'workflow-handoff' &&
                          typeof options.phone.liveWorkflowRuns === 'function') {
                        try {
                          workflowRuns = (await options.phone.liveWorkflowRuns(
                            roomId, principal.identityId)).workflows;
                        } catch {
                          // A workflow read failure leaves the ordinary HTTP
                          // resource path as the covering read.
                        }
                      }
                      let starPrompt;
                      if (result.delta.type === 'message-delta' &&
                          typeof options.phone.liveStarPrompt === 'function') {
                        const message = result.delta.message;
                        if ((message.author.kind === 'agent' && ((message.attachments?.length ?? 0) > 0 ||
                            message.reactions?.some(reaction => reaction.emoji === '👍' && reaction.reacted))) ||
                            message.systemEvent?.kind === 'workflow-handoff') {
                          try { starPrompt = await options.phone.liveStarPrompt(principal.identityId); }
                          catch { /* Keep the committed message available when optional eligibility fails. */ }
                        }
                      }
                      const publicDelta = { ...result.delta,
                        ...(workflowRuns ? { workflowRuns } : {}),
                        ...(starPrompt ? { starPrompt: starPrompt.prompt } : {}) };
                      if (!currentEpoch()) return;
                      // Never roll a row back after a newer projection.
                      if (!admitRow(rowKey,
                        publicDelta.type === 'message-delta' && publicDelta.version !== undefined
                          ? { version: publicDelta.version } : undefined,
                        createHash('sha256').update(JSON.stringify(publicDelta)).digest('hex')))
                        return;
                      rememberPaintTrace(wireTrace, target.type);
                      const sidebarOnly = previewRooms.has(roomId) && !viewedRooms.has(roomId);
                      // Voice cards change a separate list mark; retain its covering read.
                      let wireDelta: object = publicDelta;
                      if (sidebarOnly && publicDelta.type === 'message-delta' &&
                          !offscreenMessageFits(publicDelta)) {
                        const preview = publicDelta.message.voiceCall ? null
                          : projectSidebarPreview(publicDelta, principal.identityId);
                        wireDelta = preview && readSidebarPreview(preview) ? preview : wireEvent;
                      }
                      sendFrame({ ...wireDelta,
                        ...(wireTrace ? { trace: wireTrace } : {}) });
                      if (result.delta.type === 'message-delta') {
                        const message = result.delta.message;
                        if (message.author.pubkey === principal.identityId ||
                            message.presentation === 'card' || message.presentation === 'system' ||
                            (message.mentionPubkeys?.includes(principal.identityId) &&
                              isNeedsYouAsk(message.text))) sendNeedsYouDelta(event, roomId);
                      }
                    })
                    .catch((error) => {
                      console.error(
                        '[live] committed row delivery failed',
                        error instanceof Error ? error.message : String(error),
                      );
                      if (client.readyState === client.OPEN) {
                        rememberPaintTrace(wireTrace, target.type);
                        sendFrame(fallback);
                      }
                    })
                    .finally(() => endRowRead(rowKey));
              };
              const subscription = options.replay
                ? await options.replay.subscribe(`room:${roomId}`, roomId, readLiveCursor(cursor), forwardEvent,
                    (sequence, epoch, reload) => {
                      sendLive(JSON.stringify({ type: reload ? 'reload' : 'cursor', roomId, sequence, epoch }));
                      if (!epoch) client.close(1013, 'live replay unavailable');
                    },
                    async () => (await options.phone.canReadRooms([roomId], principal.identityId)).has(roomId))
                : options.live.subscribeReplay(roomId, resume, forwardEvent);
              if (client.readyState !== client.OPEN) { subscription.release(); return; }
              releases.set(roomId, subscription.release);
              sendLive(JSON.stringify({ type: 'subscribed', roomId,
                epoch: subscription.epoch,
                cursor: subscription.resumed ? resume!.base : subscription.sequence,
                resumed: subscription.resumed }));
              if (subscription.resumed) {
                for (const { event, sequence } of subscription.replay)
                  await forwardEvent(event, sequence, subscription.epoch);
                // Filtered or unchanged rows still advance the durable cursor.
                if ('start' in subscription) sendLive(JSON.stringify({ type: 'cursor', roomId,
                  sequence: subscription.sequence, epoch: subscription.epoch }));
              }
              if ('start' in subscription && typeof subscription.start === 'function') subscription.start();
              else if (subscription.resumed) continue;
              // A live lane carries only what is written after this point, so a
              // reader who joins a turn already in progress has missed the draft
              // it is writing. Hand over the running one now; every later delta
              // arrives through the subscription above and replaces it. A read
              // that fails leaves the lane exactly as it was before.
              const snapshot = await options.phone
                .liveDraftSnapshot(roomId)
                .catch(() => [] as LiveEvent[]);
              for (const event of snapshot) {
                if (event.type === 'draft' && streamed.has(event.agentId)) continue;
                if (client.readyState === client.OPEN &&
                    (event.type === 'draft' || event.type === 'thought')) sendDraft(event);
              }
              for (const event of options.live.presenceSnapshot(roomId)) {
                if (client.readyState === client.OPEN) sendLive(JSON.stringify(event));
              }
            }
          }
          if (
            item.type === 'viewing' &&
            typeof item.roomId === 'string' &&
            ROOM_ID_PATTERN.test(item.roomId) &&
            typeof item.viewing === 'boolean'
          ) {
            if (item.viewing) viewedRooms.add(item.roomId);
            else viewedRooms.delete(item.roomId);
            if (!phoneViewClosed)
              await phoneViewing.view(viewingSession, principal.identityId, item.roomId, item.viewing);
            return;
          }
          if (item.type === 'unsubscribe' && typeof item.roomId === 'string') {
            releases.get(item.roomId)?.();
            releases.delete(item.roomId);
            previewRooms.delete(item.roomId);
            sentRows.delete(`${item.roomId}:corner-status`);
            for (const key of draftWire.keys())
              if (key.startsWith(`${item.roomId}:`)) draftWire.delete(key);
          }
        };
        socketTaskTail = socketTaskTail
          .then(async () => {
            if (client.readyState !== client.OPEN) return;
            const releaseDbTask = await acquireLiveDbTask();
            try {
              if (client.readyState === client.OPEN) await processMessage();
            } finally {
              releaseDbTask();
            }
          })
          .catch((error) => {
            const retryable = isRetryableLiveError(error);
            const code =
              error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
            const kind = retryable ? 'database' : code === '22P02' ? 'invalid' : 'internal';
            liveErrors[kind]++;
            console.error('[live] message failed', { kind, error });
            if (client.readyState === client.OPEN)
              client.close(
                retryable ||
                  (error instanceof Error && error.message === 'live admission overloaded')
                  ? 1013
                  : 1011,
                'live request failed',
              );
          })
          .finally(() => {
            socketTasks--;
            socketQueuedBytes -= frameBytes;
          });
      });
      const releasePhoneView = () => {
        if (phoneViewClosed) return;
        phoneViewClosed = true;
        void phoneViewing.end(viewingSession).catch((error) =>
          console.error('[live] viewing release failed', error),
        );
      };
      client.on('error', releasePhoneView);
      client.on('close', () => {
        socketSubscriptions.delete(client);
        options.live.humanDisconnected(principal.identityId);
        releasePhoneView();
        releaseWorkspaces();
        releasePersonalResync();
        pendingPaintTraces.clear();
        for (const release of releases.values()) release();
        for (const release of workspaceReleases.values()) release();
        workspaceReleases.clear();
        releases.clear();
        draftWire.clear();
        sentRows.clear();
      });
    },
  );
  server.once('listening', () => { void options.daemon.warmConnectorIndex?.(); });
  return server;
}

const phoneFamilies = new WeakMap<IncomingMessage, string>();

/** Identity plus the sign-in family, when this auth implementation can name one. */
async function readPhoneSession(
  auth: {
    authenticatePhone(token: string): Promise<string | null>;
    authenticatePhoneSession?(token: string): Promise<{ identityId: string; familyId: string } | null>;
  },
  token: string,
): Promise<{ identityId: string; familyId: string | null } | null> {
  if (typeof auth.authenticatePhoneSession === 'function') {
    const session = await auth.authenticatePhoneSession(token);
    return session ? { identityId: session.identityId, familyId: session.familyId } : null;
  }
  const identityId = await auth.authenticatePhone(token);
  return identityId ? { identityId, familyId: null } : null;
}

async function phoneIdentity(
  request: IncomingMessage,
  options: ServerOptions,
): Promise<string | null> {
  const value = bearer(request.headers.authorization);
  // Family is recorded beside the identity lookup. The identity return stays the
  // access-token query System messages already follow.
  if (value) await rememberPhoneFamily(request, options.auth, value);
  return value ? options.auth.authenticatePhone(value) : null;
}

async function rememberPhoneFamily(
  request: IncomingMessage,
  auth: TokenAuth,
  token: string,
): Promise<void> {
  if (typeof auth.authenticatePhoneSession !== 'function') return;
  const session = await auth.authenticatePhoneSession(token);
  if (session?.familyId) phoneFamilies.set(request, session.familyId);
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
  liveHealth: () => object,
  helperVersionGate: HelperVersionGate,
  dispatchPhoneOperation: PhoneOperationDispatcher,
): Promise<void> {
  const url = exactPath(request.url);
  const method = request.method ?? 'GET';
  if (await options.roomsMcp?.handle(request, response)) return;
  if (method === 'POST' && url.pathname === '/v1/sentry/webhook') {
    let raw: Buffer;
    try { raw = await bytes(request, MAX_JSON_BYTES); }
    catch { json(response, 413, { error: 'sentry_payload_too_large' }); return; }
    const status = await receiveSentryWake(options.database, raw, request.headers, options.sentryWakeSecret, options.sentryWakeAgentId);
    json(response, status, status < 300 ? { accepted: true } : { error: 'invalid_sentry_webhook' });
    return;
  }
  if (method === 'POST' && url.pathname === '/api/webhooks/sentry') {
    if (!authenticSentryAlert(options.sentryTelegram, url.searchParams.get('token'))) {
      json(response, 401, { error: 'invalid_sentry_webhook' }); return;
    }
    let payload: Record<string, unknown>;
    try { payload = await body(request); }
    catch { json(response, 400, { error: 'invalid_sentry_alert' }); return; }
    const message = sentryTelegramMessage(payload);
    if (!message) { json(response, 400, { error: 'invalid_sentry_alert' }); return; }
    await sendSentryTelegram(options.sentryTelegram!, message);
    json(response, 200, { ok: true }); return;
  }
  if (url.pathname.startsWith('/v1/free-agents/model/')) {
    if (!options.freeAgentModel) json(response, 503, { error: { message: 'free agent model unavailable' } });
    else await handleFreeAgentModelRequest(request, response, url.pathname, options.freeAgentModel);
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/free-agents/bootstrap') {
    const input = await body(request);
    const grant =
      options.freeAgents && typeof input.token === 'string' && input.token.startsWith('bfb_')
        ? await options.freeAgents.bootstrap(input.token)
        : undefined;
    if (!grant) json(response, 401, { error: 'invalid_free_agent_bootstrap' });
    else {
      response.setHeader('cache-control', 'no-store');
      json(response, 200, grant);
    }
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/free-agents/sleep') {
    const agentId = await daemonIdentity(request, options);
    if (!agentId) {
      await refuseDaemon(request, response, options);
      return;
    }
    const input = await body(request);
    json(response, 200, options.freeAgents
      ? await options.freeAgents.requestSleep(agentId, { refresh: input.refresh === true })
      : { sleep: false });
    return;
  }
  const computer = /^\/s\/([A-Za-z0-9_-]{43})\/?$/.exec(url.pathname);
  if (method === 'GET' && computer) {
    await serveComputerSession(request, response, options.database, options.live, computer[1]!);
    return;
  }
  const computerStatus = /^\/s\/([A-Za-z0-9_-]{43})\/status$/.exec(url.pathname);
  if (method === 'GET' && computerStatus) {
    await serveComputerStatus(request, response, options.database, computerStatus[1]!);
    return;
  }
  if (method === 'GET' && url.pathname === '/v1/link/oauth/callback') {
    if (!options.linkWallet) {
      json(response, 503, { error: 'Link is unavailable' });
      return;
    }
    const state = url.searchParams.get('state');
    if (!state) {
      json(response, 400, { error: 'Link authorization was not completed' });
      return;
    }
    const result = await options.linkWallet.complete(
      state,
      url.searchParams.get('code') ?? undefined,
      url.searchParams.get('error') ?? undefined,
      url.searchParams.get('error_description') ?? undefined,
    );
    const webOrigin = appSignInWebOrigin(request, options);
    if (webOrigin) {
      const destination = new URL('/beeline/settings/workbench', webOrigin);
      response.writeHead(302, { location: destination.toString(),
        'set-cookie': `${appSignInReturnCookie}=; Path=/v1; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
        'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      response.end();
      return;
    }
    if (/\b(?:Android|iPhone|iPad|iPod)\b/i.test(request.headers['user-agent'] ?? '')) {
      const appReturn = new URL('beeline://beeline/settings/workbench');
      if (result.ownerId) appReturn.searchParams.set('viewerId', result.ownerId);
      response.writeHead(302, {
        location: appReturn.toString(),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      response.end();
    } else {
      response.writeHead(result.completed ? 200 : 400, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      response.end(
        result.completed
          ? '<p>Link connected. Return to Beeline.</p>'
          : '<p>Link sign-in did not complete. Return to Beeline and retry.</p>',
      );
    }
    return;
  }
  if (method === 'GET' && url.pathname === '/v1/apps/oauth/start') {
    // Beeline web opens the provider through here so the verifier below can
    // send this browser back to the web app instead of the native app scheme.
    const authorization = url.searchParams.get('authorization') ?? '';
    const webOrigin = url.searchParams.get('return') ?? '';
    let isLinkSignIn = false;
    let safeAuthorization = false;
    try {
      const provider = new URL(authorization);
      safeAuthorization = provider.protocol === 'https:' && !provider.username && !provider.password
        && authorization.length <= 4096;
      isLinkSignIn = provider.origin === 'https://login.link.com' && provider.pathname === '/auth'
        && !provider.username && !provider.password;
    } catch { /* Invalid URLs are refused below. */ }
    if (!safeAuthorization || !options.webAppOrigins?.includes(webOrigin)) {
      json(response, 400, { error: 'Invalid app sign-in start' });
      return;
    }
    const storedSignIn = !isAppSignInLink(authorization) && !isLinkSignIn
      ? (await options.database.query(`SELECT 1 FROM workspace_connectors
          WHERE status='installing' AND sign_in->>'url'=$1
          UNION ALL SELECT 1 FROM agents WHERE squire_work->>'install'='true'
            AND squire_work->'signIn'->>'url'=$1 LIMIT 1`, [authorization])).rowCount > 0 : false;
    if (!(isAppSignInLink(authorization) || isLinkSignIn || storedSignIn) || !options.webAppOrigins?.includes(webOrigin)) {
      json(response, 400, { error: 'Invalid app sign-in start' });
      return;
    }
    response.writeHead(302, {
      location: authorization,
      'set-cookie': `${appSignInReturnCookie}=${encodeURIComponent(webOrigin)}; Path=/v1; Max-Age=900; HttpOnly; Secure; SameSite=Lax`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    });
    response.end();
    return;
  }
  if (method === 'GET' && url.pathname === '/v1/apps/oauth/verify') {
    const sessionUri = url.searchParams.get('session_uri');
    if (!sessionUri || sessionUri.length > 4096) {
      json(response, 400, { error: 'Invalid app sign-in session' });
      return;
    }
    const webOrigin = appSignInWebOrigin(request, options);
    if (webOrigin) {
      const webReturn = new URL('/beeline/settings/workbench/connect-signin', webOrigin);
      webReturn.searchParams.set('appSignInSession', sessionUri);
      response.writeHead(302, {
        location: webReturn.toString(),
        'set-cookie': `${appSignInReturnCookie}=; Path=/v1; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      });
      response.end();
      return;
    }
    const destination = new URL('beeline://beeline/settings/workbench/connect-signin');
    destination.searchParams.set('appSignInSession', sessionUri);
    const href = destination.toString().replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    const nonce = randomUUID();
    // Browsers can block an automatic app handoff. Keep the same session in a
    // visible link so a deliberate tap can finish without starting sign-in again.
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    });
    response.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Return to Beeline</title><style nonce="${nonce}">
body { margin: 0; padding: 32px 24px; font: 18px/1.5 system-ui, sans-serif; background: #14091a; color: #f7f3f8; }
main { max-width: 420px; margin: 12vh auto; } h1 { font-size: 28px; line-height: 1.2; }
p { color: #d3c8d7; } a { display: inline-block; padding: 14px 24px; border-radius: 10px; background: #f7f3f8; color: #14091a; font-weight: 600; text-decoration: none; }
a:focus-visible { outline: 3px solid #c8a8e8; outline-offset: 4px; }
</style></head><body><main><h1>Return to Beeline</h1>
<p>Return to Beeline to finish connecting your app. If it doesn't open automatically, tap below.</p>
<a id="open-beeline" href="${href}">Open Beeline</a>
</main><script nonce="${nonce}">window.location.href = document.getElementById('open-beeline').href;</script></body></html>`);
    return;
  }
  if (method === 'GET' && url.pathname === '/v1/registry-mcp/oauth/callback') {
    if (!options.registryMcpOAuth) {
      json(response, 503, { error: 'Registry MCP OAuth is unavailable' });
      return;
    }
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    if (!state) {
      json(response, 400, { error: 'Provider authorization was not completed' });
      return;
    }
    const completed = code
      ? await options.registryMcpOAuth.complete(state, code)
      : (await options.registryMcpOAuth.cancel(state), false);
    const webOrigin = appSignInWebOrigin(request, options);
    if (webOrigin) {
      response.writeHead(302, { location: new URL('/beeline/settings/workbench', webOrigin).toString(),
        'set-cookie': `${appSignInReturnCookie}=; Path=/v1; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
        'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
      response.end();
      return;
    }
    response.writeHead(completed ? 200 : 400, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(
      completed
        ? '<p>Provider sign-in completed. Return to Beeline while the helper connects the tool.</p>'
        : '<p>Provider sign-in did not complete. Return to Beeline and retry.</p>',
    );
    return;
  }
  if (options.authHandler && url.pathname.startsWith('/auth/')) {
    options.authHandler(request, response);
    return;
  }
  if (method === 'GET' && url.pathname === '/health') {
    const diagnostics = options.healthDatabase ?? options.database;
    await diagnostics.query('SELECT 1');
    const pool = options.database.poolCounts?.() ?? { total: 0, idle: 0, waiting: 0 };
    // Read the age from the APP database, the same object the pool counts come
    // from. The diagnostics handle has its own pool and its own in-flight set,
    // so asking it would report the health check's own query rather than the
    // work that can actually be stuck.
    const oldestActiveQueryAgeMs = await options.database.oldestActiveQueryAgeMs?.();
    const pools =
      options.databasePools &&
      Object.fromEntries(
        Object.entries(options.databasePools).map(([name, database]) => {
          const counts = database.poolCounts?.() ?? { total: 0, idle: 0, waiting: 0 };
          return [
            name,
            {
              size: counts.total,
              inUse: counts.total - counts.idle,
              waiting: counts.waiting,
              telemetry: database.poolTelemetry?.() ?? null,
            },
          ];
        }),
      );
    json(response, 200, {
      ok: true,
      database: {
        pool: {
          size: pool.total,
          inUse: pool.total - pool.idle,
          waiting: pool.waiting,
        },
        oldestActiveQueryAgeMs: oldestActiveQueryAgeMs ?? null,
        ...(options.database.queryProfiles
          ? { queryProfiles: options.database.queryProfiles() }
          : {}),
        ...(options.databaseBudget ? { budget: options.databaseBudget } : {}),
        ...(pools
          ? { pools }
          : options.enrichmentDatabase || options.jobsDatabase || options.healthDatabase
            ? {
                pools: Object.fromEntries(
                  (
                    [
                      ['enrichment', options.enrichmentDatabase],
                      ['diagnostics', options.healthDatabase],
                      ['jobs', options.jobsDatabase],
                    ] as const
                  )
                    .filter(([, db]) => !!db)
                    .map(([name, db]) => {
                      const counts = db?.poolCounts?.() ?? { total: 0, idle: 0, waiting: 0 };
                      return [
                        name,
                        {
                          size: counts.total,
                          inUse: counts.total - counts.idle,
                          waiting: counts.waiting,
                        },
                      ];
                    }),
                ),
              }
            : {}),
        ...(options.database.oldestActiveTransactionAgeMs
          ? { oldestActiveTransactionAgeMs: options.database.oldestActiveTransactionAgeMs() }
          : {}),
        ...(options.database.transactionDeadlineCount
          ? { transactionDeadlines: options.database.transactionDeadlineCount() }
          : {}),
      },
      live: liveHealth(),
      ...(options.backgroundHealth ? { background: options.backgroundHealth() } : {}),
      ...(options.liveBridgeHealth ? { liveBridge: options.liveBridgeHealth() } : {}),
    });
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
      ...(helperVersionGate.minimum ? { minimumHelperVersion: helperVersionGate.minimum } : {}),
    });
    return;
  }
  if (url.pathname === '/v1/site/download-tap') {
    response.setHeader('vary', 'Origin');
    response.setHeader('cache-control', 'no-store');
    if (request.headers.origin !== 'https://usebeeline.app') {
      json(response, 403, { error: 'origin_denied' }); return;
    }
    response.setHeader('access-control-allow-origin', 'https://usebeeline.app');
    if (method === 'OPTIONS') {
      response.writeHead(204, { 'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' });
      response.end(); return;
    }
    if (method !== 'POST') { json(response, 405, { error: 'method_not_allowed' }); return; }
    let input: unknown;
    try { input = JSON.parse((await bytes(request, 256)).toString('utf8')); }
    catch { json(response, 400, { error: 'invalid_download_tap' }); return; }
    const tap = parseSiteDownloadTap(input);
    if (!tap) { json(response, 400, { error: 'invalid_download_tap' }); return; }
    if (!await recordSiteDownloadTap(options.database, tap)) {
      json(response, 429, { error: 'daily_cap_reached' }); return;
    }
    response.writeHead(204); response.end(); return;
  }
  if (method === 'POST' && url.pathname === '/v1/admin/dashboard/x-ads/screen') {
    if (!options.dashboardSecret || !bearerSecretMatches(options.dashboardSecret, request)) {
      json(response, 403, { error: 'access_denied' });
      return;
    }
    let input: unknown;
    try { input = await body(request); }
    catch { json(response, 400, { error: 'invalid_screen_report' }); return; }
    const report = parseScreenReport(input);
    if (!report) { json(response, 400, { error: 'invalid_screen_report' }); return; }
    json(response, 200, await ingestScreenReport(options.database, report));
    return;
  }
  if (method === 'GET' && url.pathname === '/v1/admin/dashboard') {
    // Authentication happens before parsing the filter or reading any ledger.
    // The browser never receives this key; the same-origin edge proxy supplies it.
    if (!options.dashboardSecret || !bearerSecretMatches(options.dashboardSecret, request)) {
      json(response, 403, { error: 'access_denied' });
      return;
    }
    const platforms = parseDashboardPlatforms(url.searchParams.get('platforms'));
    if (
      !platforms ||
      [...url.searchParams.keys()].some((key) => key !== 'platforms') ||
      url.searchParams.getAll('platforms').length > 1
    ) {
      json(response, 400, { error: 'invalid_platforms' });
      return;
    }
    json(
      response,
      200,
      await readOperatorDashboard(
        options.database,
        platforms,
        process.env.BEELINE_DASHBOARD_LATEST_MOBILE_RELEASE ?? 'development',
        {
          ...(process.env.BEELINE_DASHBOARD_MIN_RUNTIME_IOS &&
          /^\d+$/.test(process.env.BEELINE_DASHBOARD_MIN_RUNTIME_IOS)
            ? { ios: Number(process.env.BEELINE_DASHBOARD_MIN_RUNTIME_IOS) }
            : {}),
          ...(process.env.BEELINE_DASHBOARD_MIN_RUNTIME_ANDROID &&
          /^\d+$/.test(process.env.BEELINE_DASHBOARD_MIN_RUNTIME_ANDROID)
            ? { android: Number(process.env.BEELINE_DASHBOARD_MIN_RUNTIME_ANDROID) }
            : {}),
        },
      ),
    );
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
  if (method === 'GET' && url.pathname === '/v1/public/mobile-minimum') {
    try {
      publicJson(response, 200, await readMobileMinimums(options.database));
    } catch {
      publicJson(response, 503, {});
    }
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/releases/mobile-minimum') {
    if (!options.releaseNotify?.secret || !bearerSecretMatches(options.releaseNotify.secret, request)) {
      json(response, 403, { error: 'release_notify_access_denied' });
      return;
    }
    const input = await body(request);
    const minimum = parseMobileMinimum(input);
    if (!minimum || (input.platform !== 'android' && input.platform !== 'ios')) {
      json(response, 400, { error: 'platform, valid minVersion and reason required' });
      return;
    }
    await writeMobileMinimum(options.database, input.platform, minimum);
    json(response, 200, { platform: input.platform, ...minimum });
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/releases/helper-minimum') {
    if (
      !options.releaseNotify?.secret ||
      !bearerSecretMatches(options.releaseNotify.secret, request)
    ) {
      json(response, 403, { error: 'release_notify_access_denied' });
      return;
    }
    const input = await body(request);
    if (typeof input.minVersion !== 'string') {
      json(response, 400, { error: 'minVersion_required' });
      return;
    }
    try {
      helperVersionGate.raise(input.minVersion);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'invalid minimum helper version';
      json(response, reason.includes('cannot decrease') ? 409 : 400, { error: reason });
      return;
    }
    json(response, 200, { minVersion: helperVersionGate.minimum });
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
  if (method === 'POST' && url.pathname === '/v1/funnel/events') {
    if (!funnelRateLimit.allow(clientKey(request))) { json(response,429,{error:'too_many_requests'}); return; }
    let input: unknown;
    try { input = JSON.parse((await bytes(request, 1024)).toString('utf8')); }
    catch { json(response,400,{error:'invalid_funnel_event'}); return; }
    const event = parseSigninFunnelEvent(input);
    if (!event) { json(response,400,{error:'invalid_funnel_event'}); return; }
    const requiresIdentity = ['signed_in', 'workspace_created', 'first_message_sent', 'screen_shown'].includes(event.event);
    const viewerId = requiresIdentity || request.headers.authorization ? await phoneIdentity(request,options) : undefined;
    if (requiresIdentity && !viewerId) { json(response,401,{error:'unauthorized'}); return; }
    await recordSigninFunnelEvent(options.database,event,'client',viewerId ?? undefined);
    response.writeHead(204); response.end(); return;
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
  if (method === 'POST' && url.pathname === '/v1/auth/google/link') {
    const viewerId = await phoneIdentity(request, options);
    if (!viewerId) { json(response, 401, { error: 'unauthorized' }); return; }
    const input = await body(request);
    if (typeof input.oidcToken !== 'string') throw new Error('oidcToken is required');
    await options.auth.linkGoogleOidc(viewerId, input.oidcToken);
    response.writeHead(204);
    response.end();
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/auth/google/exchange') {
    const input = await body(request);
    if (typeof input.oidcToken !== 'string') throw new Error('oidcToken is required');
    try {
      const tokens = await options.auth.exchangeGoogleOidc(input.oidcToken, input.xAttribution);
      const funnel = parseSigninFunnelEvent(input.funnel);
      if (funnel && funnel.event === 'provider_tapped' && funnel.provider === 'google') {
        await recordSigninFunnelEvent(options.database, {...funnel, event: 'signed_in'}, 'server', tokens.identityId).catch(() => undefined);
      }
      json(response, 200, tokens);
    } catch (error) {
      if (!(error instanceof GoogleSignInError)) throw error;
      json(response, 401, { error: 'google_sign_in_failed' });
    }
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/auth/github/exchange') {
    const input = await body(request);
    if (typeof input.oidcToken !== 'string') throw new Error('oidcToken is required');
    const tokens=await options.auth.exchangeGitHubOidc(input.oidcToken, input.xAttribution);
    const funnel=parseSigninFunnelEvent(input.funnel);
    if(funnel && funnel.event==='provider_tapped' && funnel.provider==='github') {
      await recordSigninFunnelEvent(options.database,{...funnel,event:'signed_in'},'server',tokens.identityId).catch(()=>undefined);
    }
    json(response,200,tokens);
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
  if (method === 'POST' && url.pathname === '/v1/auth/logout') {
    const input = await body(request);
    if (typeof input.refreshToken !== 'string') throw new Error('refreshToken is required');
    await options.auth.revokePhoneSession(input.refreshToken);
    json(response, 200, { signedOut: true });
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/auth/refresh') {
    const input = await body(request);
    if (typeof input.refreshToken !== 'string') throw new Error('refreshToken is required');
    const result = await options.auth.refresh(input.refreshToken);
    json(response, result ? 200 : 401, result ?? { error: 'stale_refresh_token' });
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/auth/daemon/migrate-legacy') {
    const origin = options.legacyMigrationOrigin ?? process.env.BEELINE_MONOLITH_BASE_URL ?? 'https://server.usebeeline.app';
    const proof = verifyNip98Header(request.headers.authorization, `${origin.replace(/\/$/, '')}/v1/auth/daemon/migrate-legacy`, 'POST');
    if (!proof.ok) { json(response, 401, { error: 'legacy_identity_proof_required' }); return; }
    const input = await body(request);
    if (typeof input.workspaceId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(input.workspaceId) || typeof input.pairedBy !== 'string') {
      json(response, 400, { error: 'legacy_pairing_required' }); return;
    }
    const result = await options.auth.migrateLegacyDaemon({ agentId: proof.pubkey, proofId: proof.eventId, workspaceId: input.workspaceId, pairedBy: input.pairedBy });
    json(response, result ? 200 : 403, result ?? { error: 'legacy_reconnect_required' });
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

  const walletWebhookPath = /^\/v1\/wallet\/events\/cdp\/([a-zA-Z0-9_-]{1,100})$/.exec(url.pathname);
  if (method === 'POST' && walletWebhookPath) {
    const secret = options.cdpWebhookSecrets?.[walletWebhookPath[1]!];
    if (typeof secret !== 'string' || !secret) {
      json(response, 404, { error: 'not_found' });
      return;
    }
    const raw = await bytes(request, MAX_JSON_BYTES);
    const accepted = await ingestWalletWebhook(options.database, raw, request.headers, secret);
    json(response, accepted ? 200 : 401,
      accepted ? { accepted: true } : { error: 'invalid_wallet_webhook' });
    return;
  }

  const subscriptionHook = /^\/hooks\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(url.pathname);
  if (method === 'POST' && subscriptionHook) {
    const chunks: Buffer[] = [];
    let size = 0;
    let retained = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      const keep = buffer.subarray(0, Math.max(0, WEBHOOK_BODY_LIMIT + 1 - retained));
      if (keep.length) { chunks.push(keep); retained += keep.length; }
    }
    const result = await ingestSubscriptionWebhook(options.database, subscriptionHook[1]!,
      Buffer.concat(chunks), { ...request.headers,
        'x-beeline-signature': request.headers['x-beeline-signature'] ?? url.searchParams.get('signature') ?? undefined,
        'x-beeline-delivery': request.headers['x-beeline-delivery'] ?? url.searchParams.get('delivery') ?? undefined,
      }, size);
    json(response, result.status, { outcome: result.outcome });
    return;
  }

  const providerWebhookPath = /^\/v1\/connectors\/events\/(linear|stripe)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(url.pathname);
  if (method === 'POST' && providerWebhookPath) {
    const raw = await bytes(request, MAX_JSON_BYTES);
    const accepted = await ingestProviderWebhook(options.database,
      providerWebhookPath[1] as 'linear' | 'stripe', providerWebhookPath[2]!, raw, request.headers);
    if (!accepted) {
      json(response, 401, { error: 'invalid_webhook_signature' });
      return;
    }
    json(response, 200, { accepted: true });
    return;
  }

  if (method === 'POST' && url.pathname === '/v1/connectors/events/composio') {
    if (!options.composio || !options.composioReceiverUrl) {
      json(response, 404, { error: 'not_found' });
      return;
    }
    const raw = await bytes(request, MAX_JSON_BYTES);
    const secret = await options.composio.triggerReceiverSecret(options.composioReceiverUrl);
    const accepted = await ingestComposioDelivery(options.database, raw, request.headers, secret);
    if (!accepted) {
      json(response, 401, { error: 'invalid_webhook_signature' });
      return;
    }
    json(response, 200, { accepted: true });
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
    if (options.github?.onWebhook) await options.github.onWebhook(event, parsed, delivery);
    const inserted = await options.database.query(
      `INSERT INTO github_webhook_deliveries(delivery_id) VALUES($1) ON CONFLICT DO NOTHING`,
      [delivery],
    );
    const accepted = Boolean(inserted.rowCount);
    if (accepted && ++webhookWritesSincePrune % 64 === 1) {
      try {
        await options.database.query(
          `DELETE FROM github_webhook_deliveries delivery
           WHERE delivery.delivery_id IN (
             SELECT delivery_id FROM github_webhook_deliveries
             WHERE received_at<now()-interval '30 days'
             ORDER BY received_at,delivery_id LIMIT 1024 FOR UPDATE SKIP LOCKED)`,
        );
        await options.database.query(
          `UPDATE github_webhook_deliveries delivery SET payload=NULL,event_type=NULL,processed_at=NULL
           WHERE delivery.delivery_id IN (
             SELECT delivery_id FROM github_webhook_deliveries
             WHERE payload IS NOT NULL
             ORDER BY received_at,delivery_id LIMIT 1024 FOR UPDATE SKIP LOCKED)`,
        );
      } catch (error) {
        console.warn('[github-webhook] retention prune failed', error);
      }
    }
    json(response, accepted ? 202 : 200, {
      accepted,
      duplicate: !accepted,
    });
    return;
  }

  if (method === 'GET' && url.pathname.startsWith('/v1/company-logos/')) {
    let id: string;
    try { id = decodeURIComponent(url.pathname.slice('/v1/company-logos/'.length)); }
    catch { json(response, 400, { error: 'invalid_company' }); return; }
    const image = await readCompanyLogo(id);
    if (!image) { json(response, 404, { error: 'company_icon_unavailable' }); return; }
    response.writeHead(200, { 'content-type': image.mime, 'content-length': String(image.bytes.length),
      'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox" });
    response.end(image.bytes); return;
  }
  if (method === 'GET' && url.pathname.startsWith('/v1/connectors/logo/')) {
    const type = url.pathname.slice('/v1/connectors/logo/'.length).replace(/\.svg$/, '');
    const logo = connectorLogo(type);
    if (!logo) {
      json(response, 404, { error: 'connector_not_found' });
      return;
    }
    response.writeHead(200, {
      'content-type': 'image/svg+xml',
      'content-length': String(Buffer.byteLength(logo)),
      'cache-control': 'public, max-age=86400',
      'x-content-type-options': 'nosniff',
    });
    response.end(logo);
    return;
  }
  const nativeVoiceStop = url.pathname.match(/^\/v1\/phone\/voice\/([0-9a-f-]{36})\/native-stop$/);
  if (nativeVoiceStop && method === 'POST') {
    if (!options.voice) { json(response, 503, { error: 'Voice mode is unavailable' }); return; }
    const accepted = await options.voice.nativeStop(nativeVoiceStop[1]!, (await body(request)).token);
    json(response, accepted ? 200 : 403, accepted ? { left: true } : { error: 'invalid_voice_stop' });
    return;
  }
  if (method === 'GET' && await serveEmailImage(options.database, url, response)) return;
  const identityId = await phoneIdentity(request, options);
  if (
    method === 'GET' &&
    (url.pathname.startsWith('/v1/avatars/') || url.pathname.startsWith('/v1/agent-avatars/'))
  ) {
    const agentAvatar = url.pathname.startsWith('/v1/agent-avatars/');
    const id = url.pathname.slice(
      agentAvatar ? '/v1/agent-avatars/'.length : '/v1/avatars/'.length,
    );
    const avatar = isMediaId(id)
      ? (
          await options.database.query<{ bytes: Uint8Array }>(
            agentAvatar
              ? 'SELECT bytes FROM agent_avatars WHERE id=$1'
              : 'SELECT bytes FROM avatars WHERE id=$1',
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
    const last = url.pathname.slice('/v1/media/'.length);
    const playMatch = last.match(/^([0-9a-f-]{36})\/play$/);
    if (playMatch) {
      if (!identityId) { json(response, 401, { error: 'identity_required' }); return; }
      const origin = runnableOrigin();
      if (!origin || !options.objectService) { json(response, 503, { error: 'game_host_unavailable' }); return; }
      const link = await options.objectService.runnableLink(playMatch[1]!, origin);
      json(response, link ? 200 : 404, link ?? { error: 'game_not_found' });
      return;
    }
    // `open in browser`: redeem the capability token minted by `/link` (a
    // browser has no bearer token for the canonical media route) into a
    // ten-minute signed storage GET. The token — an HMAC over the object id
    // and expiry — keeps the raw storage hosts out of every shareable link.
    const openMatch = last.match(/^([0-9a-f-]+)\/open$/);
    if (method === 'GET' && openMatch && isMediaId(openMatch[1]!)) {
      if (!options.objectService) {
        json(response, 503, { error: 'object_storage_unavailable' });
        return;
      }
      const expires = Number(new URL(request.url ?? '', 'http://x').searchParams.get('expires'));
      const token = new URL(request.url ?? '', 'http://x').searchParams.get('token') ?? '';
      const result = await options.objectService.openMediaLink(openMatch[1]!, expires, token);
      if (result.kind === 'redirect') {
        response.writeHead(302, { location: result.location });
        response.end();
        return;
      }
      if (result.kind === 'expired') {
        json(response, 410, { error: 'media_expired' });
        return;
      }
      if (result.kind === 'missing' || result.kind === 'pending') {
        json(response, 404, { error: 'media_not_found' });
        return;
      }
      json(response, 403, { error: 'link_invalid_or_expired' });
      return;
    }
    // `open in browser` minting: hand out the capability URL at tap time.
    const linkMatch = last.match(/^([0-9a-f-]+)\/link$/);
    if (method === 'GET' && linkMatch && isMediaId(linkMatch[1]!)) {
      if (!identityId) {
        json(response, 401, { error: 'identity_required' });
        return;
      }
      if (!options.objectService) {
        json(response, 503, { error: 'object_storage_unavailable' });
        return;
      }
      const link = await options.objectService.mediaLink(linkMatch[1]!);
      if (!link) {
        json(response, 404, { error: 'media_not_found' });
        return;
      }
      json(response, 200, link);
      return;
    }
    const mediaId = last;
    // An id that is not a UUID never named a row, and must not reach the uuid
    // cast below, where Postgres would answer a client typo with a 500.
    if (!isMediaId(mediaId)) {
      json(response, 404, { error: 'media_not_found' });
      return;
    }
    // Object-storage branch: a ready object redirects to a fresh signed GET;
    // the redirect itself is never cached, so every read mints its own link.
    if (options.objectService) {
      const object = await options.objectService.readMediaObject(mediaId);
      if (object?.kind === 'redirect') {
        response.writeHead(302, {
          location: object.location!,
          'cache-control': 'private, no-store',
        });
        response.end();
        return;
      }
      if (object?.kind === 'expired') {
        json(response, 410, { error: 'media_expired', ttlHours: object.ttlHours });
        return;
      }
      if (object?.kind === 'pending') {
        json(response, 404, { error: 'media_not_found' });
        return;
      }
    }
    // No bytea fallback: every file lives in `objects`. A tombstone is
    // expired; anything else never existed for readers.
    const expired = (
      await options.database.query<{ retention_hours: number }>(
        `SELECT retention_hours FROM object_expirations WHERE id=$1`,
        [mediaId],
      )
    ).rows[0];
    json(response, expired ? 410 : 404, {
      error: expired ? 'media_expired' : 'media_not_found',
      ...(expired ? { ttlHours: Number(expired.retention_hours) } : {}),
    });
    return;
  }
  if (url.pathname.startsWith('/v1/phone/') && !identityId) {
    json(response, 401, { error: 'phone_token_required' });
    return;
  }

  const operation = async (name: string, input: Record<string, unknown>, project?: (result: unknown) => unknown,
    invokeLegacy?: () => Promise<unknown>) => {
    const familyId = phoneFamilies.get(request);
    const result = await dispatchPhoneOperation(name, input, identityId!, undefined, invokeLegacy, familyId);
    if (result === undefined) {
      response.writeHead(204, { 'cache-control': 'private, no-store' });
      response.end();
    } else json(response, 200, project ? project(result) : result);
  };

  const profileVoiceMatch = url.pathname.match(
    /^\/v1\/phone\/workspaces\/([0-9a-f-]{36})\/agents\/([a-f0-9]{64})\/(voices|voice-preview)$/,
  );
  if (profileVoiceMatch) {
    const [, workspaceId, agentId, action] = profileVoiceMatch;
    if (method === 'GET' && action === 'voices')
      await operation('readAgentVoices', { workspaceId, agentId, ...(url.searchParams.has('roomId') ? { roomId: url.searchParams.get('roomId') } : {}) });
    else if (method === 'POST')
      await operation(action === 'voice-preview' ? 'previewAgentVoice' : 'saveAgentVoice', { ...(await body(request)), workspaceId, agentId });
    else json(response, 405, { error: 'method_not_allowed' });
    return;
  }
  const voiceMatch = url.pathname.match(/^\/v1\/phone\/voice\/([0-9a-f-]{36})\/(current|join|leave|idle|state|resume)$/);
  if (voiceMatch) {
    const [, id, action] = voiceMatch;
    if (method !== (action === 'current' || action === 'state' ? 'GET' : 'POST')) {
      json(response, 405, { error: 'method_not_allowed' }); return;
    }
    const name = { current: 'voiceCurrent', join: 'voiceJoin', leave: 'voiceLeave', idle: 'voiceIdle', state: 'voiceState', resume: 'voiceResume' }[action!];
    await operation(name!, {
      ...(method === 'POST' ? await body(request, true) : Object.fromEntries(url.searchParams)),
      ...(action === 'current' || action === 'join' ? { roomId: id } : { callId: id }),
    });
    return;
  }
  if (method === 'GET' && url.pathname === '/v1/phone/workspaces') {
    await operation('readWorkspaces', {}); return;
  }
  let match = url.pathname.match(/^\/v1\/phone\/workspaces\/([0-9a-f-]+)(?:\/(members|chats|search))?$/);
  if (method === 'GET' && match) {
    const [, workspaceId, action] = match;
    const query = Object.fromEntries(url.searchParams);
    if (action === 'members')
      await operation('readWorkspaceMembers', { ...query, workspaceId, offset: query.offset ? Number(query.offset) : undefined });
    else if (action === 'chats') await operation('readChats', { workspaceId });
    else if (action === 'search') await operation('searchMessages', { workspaceId, query: query.q ?? '', ...(query.before !== undefined ? { before: query.before } : {}) });
    else await operation('readWorkspace', { workspaceId });
    return;
  }
  match = url.pathname.match(/^\/v1\/phone\/workspaces\/([0-9a-f-]+)\/agents\/([0-9a-f]{64})$/);
  if (method === 'GET' && match) {
    await operation('readAgent', { workspaceId: match[1], agentId: match[2], ...(url.searchParams.has('workCursor') ? { workCursor: url.searchParams.get('workCursor') } : {}) }); return;
  }
  match = url.pathname.match(/^\/v1\/phone\/message-links\/([0-9a-f]{64})$/);
  if (method === 'GET' && match) {
    await operation('resolveMessageLink', { messageId: match[1] }); return;
  }
  const compact = wantsCompactView(request.headers[COMPACT_VIEW_HEADER]);
  match = url.pathname.match(/^\/v1\/phone\/rooms\/([0-9a-f-]+)(?:\/(history|outline|corners|read|unread))?$/);
  if (match) {
    const [, roomId, action] = match;
    if (method === 'GET' && !action) {
      await operation('readRoom', { roomId }, result => compact ? compactRoomView(result as import('@beeline/api-contract/phone').RoomView) : result); return;
    }
    if (method === 'GET' && action === 'history') {
      const query = Object.fromEntries(url.searchParams);
      const parsed = query.before?.match(/^(\d+),([0-9a-f]{64})$/);
      const name = query.after !== undefined ? 'readHistoryAfter' : query.around !== undefined ? 'readHistoryAround' : 'readHistory';
      await operation(name, { roomId,
        ...(name !== 'readHistory' ? { messageId: query.after ?? query.around } :
          parsed ? { before: { createdAt: Number(parsed[1]), id: parsed[2] } } : {}),
      }, result => compact ? compactRoomHistoryView(result as RoomHistoryView) : result); return;
    }
    if (method === 'GET' && action === 'outline') {
      await operation('readHistoryOutline', { roomId, timeZone: url.searchParams.get('tz') ?? '' }); return;
    }
    if (method === 'GET' && action === 'corners') {
      await operation('readCorners', { ...Object.fromEntries(url.searchParams), roomId, archived: url.searchParams.get('archived') === '1' }); return;
    }
    if (method === 'POST' && (action === 'read' || action === 'unread')) {
      await operation(action === 'read' ? 'markRead' : 'markUnread', { ...(await body(request)), roomId }); return;
    }
  }
  if (method === 'POST' && url.pathname === '/v1/phone/media') {
    if (!options.objectService) {
      json(response, 503, { error: 'object_storage_unavailable' });
      return;
    }
    const raw = await bytes(request, options.mediaMaximumBytes + 1);
    const mime =
      typeof request.headers['content-type'] === 'string'
        ? request.headers['content-type']
        : 'application/octet-stream';
    const name =
      typeof request.headers['x-file-name'] === 'string'
        ? request.headers['x-file-name']
        : 'upload';
    try {
      json(
        response,
        201,
        await options.phone.uploadMedia(identityId!, raw, mime, name, options.mediaMaximumBytes),
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'invalid upload';
      if (reason.includes('object storage is not configured')) {
        json(response, 503, { error: 'object_storage_unavailable' });
        return;
      }
      json(response, 400, { error: 'upload_rejected', reason });
    }
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/phone/transcriptions') {
    if (!options.speechTranscriber) {
      json(response, 503, { error: 'transcription_unavailable' });
      return;
    }
    let audio: Buffer;
    try {
      audio = await bytes(request, TRANSCRIPTION_MAXIMUM_BYTES);
    } catch {
      console.warn('[transcription] audio over the upload limit; Groq not called');
      json(response, 413, { error: 'audio_too_large' });
      return;
    }
    if (!audio.length) {
      json(response, 400, { error: 'audio_required' });
      return;
    }
    const header = (name: string) =>
      typeof request.headers[name] === 'string' ? (request.headers[name] as string) : undefined;
    let prompt: string | undefined;
    try {
      prompt = header('x-speech-prompt') && decodeURIComponent(header('x-speech-prompt')!);
    } catch {
      prompt = undefined;
    }
    try {
      const text = await options.speechTranscriber.transcribe({
        audio,
        mimeType: header('content-type') ?? 'audio/wav',
        ...(prompt ? { prompt } : {}),
        ...(header('x-speech-language') ? { language: header('x-speech-language')! } : {}),
      });
      json(response, 200, { text });
    } catch (error) {
      // The reason names only the provider status; audio and text are never logged.
      console.warn('[transcription]', error instanceof Error ? error.message : 'failed');
      json(response, 502, { error: 'transcription_failed' });
    }
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/phone/observations/client-error') {
    await operation('reportClientError', await body(request)); return;
  }
  if (method === 'POST' && url.pathname === '/v1/phone/observations/page-load') {
    await operation('reportPageLoad', await body(request)); return;
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
    const input = await body(request);
    await operation(name, input, undefined,
      () => options.phone.execute(name as never, input as never, identityId!, undefined, phoneFamilies.get(request)));
    return;
  }

  if (method === 'POST' && url.pathname === '/v1/daemon/artifacts') {
    const agentId = await daemonIdentity(request, options);
    if (!agentId) {
      await refuseDaemon(request, response, options);
      return;
    }
    void options.connectionPresence?.evidence(undefined, agentId);
    if (!options.objectService) {
      json(response, 503, { error: 'object_storage_unavailable' });
      return;
    }
    const raw = await bytes(request, ARTIFACT_MAXIMUM_BYTES + 1);
    if (raw.length > ARTIFACT_MAXIMUM_BYTES) {
      json(response, 413, { error: 'artifact_too_large', maximumBytes: ARTIFACT_MAXIMUM_BYTES });
      return;
    }
    const mime =
      typeof request.headers['content-type'] === 'string'
        ? request.headers['content-type'].split(';')[0]!.trim()
        : 'application/octet-stream';
    const title =
      typeof request.headers['x-artifact-title'] === 'string'
        ? decodeArtifactTitleHeader(request.headers['x-artifact-title'])
        : '';
    try {
      json(response, 201, await options.objectService.uploadArtifact(agentId, raw, mime, title));
    } catch (error) {
      json(response, 422, {
        error: 'artifact_rejected',
        reason: error instanceof Error ? error.message : 'invalid artifact',
      });
    }
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/daemon/uploads') {
    const agentId = await daemonIdentity(request, options);
    if (!agentId) {
      await refuseDaemon(request, response, options);
      return;
    }
    void options.connectionPresence?.evidence(undefined, agentId);
    if (!options.objectService) {
      json(response, 503, { error: 'object_storage_unavailable' });
      return;
    }
    const input = await body(request);
    try {
      json(response, 201, await options.objectService.createUpload(agentId, input as never));
    } catch (error) {
      json(response, 422, {
        error: 'upload_rejected',
        reason: error instanceof Error ? error.message : 'invalid upload',
      });
    }
    return;
  }
  match = url.pathname.match(/^\/v1\/daemon\/uploads\/([0-9a-f-]+)\/finalize$/);
  if (method === 'POST' && match) {
    const agentId = await daemonIdentity(request, options);
    if (!agentId) {
      await refuseDaemon(request, response, options);
      return;
    }
    if (!options.objectService) {
      json(response, 503, { error: 'object_storage_unavailable' });
      return;
    }
    if (!isMediaId(match[1]!)) {
      json(response, 404, { error: 'object_not_found' });
      return;
    }
    try {
      json(
        response,
        200,
        await options.objectService.finalizeUpload(agentId, { objectId: match[1]! }),
      );
    } catch {
      json(response, 404, { error: 'object_not_found' });
    }
    return;
  }
  if (method === 'POST' && url.pathname === '/v1/daemon/media') {
    // Retired: the agent file-sharing path is `post_artifact` (object storage,
    // an `objects` row, a card). The bytea `media` store takes no NEW agent
    // writes; a 410 tells an un-upgraded daemon why instead of a bare 404.
    const agentId = await daemonIdentity(request, options);
    if (!agentId) {
      await refuseDaemon(request, response, options);
      return;
    }
    void options.connectionPresence?.evidence(undefined, agentId);
    json(response, 410, {
      error: 'media_store_retired',
      detail:
        'agents share files with post_artifact; the bytea media store no longer accepts agent uploads',
    });
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
    if (name === 'getCornerAsk') {
      json(response, 410, { error: 'getCornerAsk is retired; use order and report' });
      return;
    }
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
    void options.connectionPresence?.evidence(evidenceRoom, agentId);
    const result = await options.daemon.execute(name as never, input as never, agentId);
    let context: { _beelineOwedMentions?: Awaited<ReturnType<typeof owedMentions>> } = {};
    // Only model tool responses need this private context. It must never turn a
    // committed operation into a failure, and never adds a daemon operation.
    if (request.headers['x-beeline-tool-result'] === '1') {
      try { context = { _beelineOwedMentions: await owedMentions(options.database, agentId) }; }
      catch { /* Keep the original tool result when its optional context is unavailable. */ }
    }
    json(response, 200, context._beelineOwedMentions ? { _beelineToolResult: result, ...context } : result);
    return;
  }
  json(response, 404, { error: 'not_found' });
}

function requestErrorStatus(error: unknown): number {
  if (error instanceof PhoneOperationError) return error.status;
  const message = error instanceof Error ? error.message : 'request failed';
  let status =
    error instanceof WorkflowAuthorizationError ||
    error instanceof CommandRefusalError ||
    error instanceof WorkspaceSkillNotFoundError
      ? error.status
      : institutionalMemoryErrorStatus(message) ??
        ((message.startsWith('corner brief attachment ') &&
            message.endsWith('is missing or unavailable in this Room')) ||
          message.includes('required') ||
          message.includes('invalid') ||
          message.includes('too large') ||
          message.includes('size is outside')
        ? 400
        : message === 'github_account_mismatch' ||
            message.includes('already linked') ||
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
              message.includes(WORKSPACE_ADMIN_AUTHORITY_MESSAGE) ||
              message.includes(SPENDING_OWNER_AUTHORITY_MESSAGE) ||
              message.includes('yolo cannot be enabled in a public workspace') ||
              message.includes(YOLO_AUTHORITY_MESSAGE) ||
              message.includes(CONNECTOR_OFFER_AUTHORITY_MESSAGE) ||
              message.includes(CONNECTOR_OFFER_WALLET_AUTHORITY_MESSAGE)
            ? 403
            : message.includes('not found')
              ? 404
              : 503);
  // GitHub's own outage or rate limit is a bad gateway, not this server
  // being unavailable; the message already names GitHub's status.
  if (error instanceof GitHubHttpError && (error.status >= 500 || error.status === 429 || error.rateLimited)) {
    status = 502;
  }
  return status;
}
