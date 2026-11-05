import type { RoomsMcp } from './rooms-mcp.js';
import { FunnelRateLimit } from './signin-funnel.js';
import { type SentryTelegramConfig } from './sentry-telegram.js';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type ServerResponse } from 'node:http';
import { isTransientDatabaseConnectionError, type SqlDatabase } from './database.js';
import type { FreeAgentService } from './free-agents.js';
import { type FreeAgentModelProxyOptions } from './free-agent-model-proxy.js';
import type { ComposioApps } from './composio-apps.js';
import { encodeJsonBody, type JsonEncoding } from './json-response.js';
import { type TokenAuth } from './auth.js';
import { type PhoneService } from './phone-service.js';
import { type DaemonService } from './daemon-service.js';
import type { LiveHub } from './live.js';
import type { ReviewAccess } from './review-access.js';
import type { ReleaseNotifier } from './release-notify.js';
import { type SpeechTranscriber } from './speech-transcription.js';
import type { VoiceService } from './voice-service.js';
import type { ObjectService } from './object-service.js';
import type { LinkAgentWallet } from './link-agent-wallet.js';
import type { RegistryMcpOAuth } from './registry-mcp-oauth.js';
import type { ConnectionPresence } from './connection-presence.js';
import { HelperVersionGate } from './helper-version-gate.js';
import { MACHINE_SOCKET_PROTOCOL } from './machine-connection.js';
export { createBeelineServer, phoneFamilies, phoneIdentity, daemonIdentity, refuseDaemon, type PhoneHttpOperation } from './server-create-beeline-server.js';
export { requestErrorStatus } from './server-request-error-status.js';



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
