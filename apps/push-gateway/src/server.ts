import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { NIP98_KIND, verifyEvent, verifyNip98Header, type NostrEvent } from '@beeline/nostr';
import type {
  AgentPairingAbandonView,
  AgentDetailView,
  AgentPairingClaimView,
  ChatListView,
  CornerListView,
  InviteView,
  RoomHistoryView,
  RoomView,
  WorkspaceListView,
  WorkspaceView,
} from '@beeline/buzz-client';
import { TokenRegistry } from './registry.js';
import type { TestSendReport } from './gateway.js';
import type { DaemonReleaseFleetEntry } from '@beeline/body/release-status';

const MAX_BODY_BYTES = 32 * 1024;
const NON_PRODUCTION_ENVIRONMENTS = new Set(['test', 'emulator', 'simulator']);

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(`${JSON.stringify(body)}\n`);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function authenticatedPubkey(request: IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith('Nostr ')) return null;
  try {
    const event = JSON.parse(
      Buffer.from(authorization.slice('Nostr '.length), 'base64').toString('utf8'),
    ) as NostrEvent;
    if (event.kind !== NIP98_KIND || !verifyEvent(event)) return null;
    if (Math.abs(Math.floor(Date.now() / 1000) - event.created_at) > 300) return null;
    const method = event.tags.find((tag) => tag[0] === 'method')?.[1];
    const target = event.tags.find((tag) => tag[0] === 'u')?.[1];
    if (method !== request.method || !target) return null;
    const url = new URL(target);
    // relay-front intentionally strips the public /push prefix before proxying
    // to this server. Accept exactly the native route or that one known public
    // prefix so a correctly signed https://usebeeline.app/push/* request keeps
    // its NIP-98 authorization after the rewrite.
    const acceptedPaths = new Set([request.url, `/push${request.url}`]);
    if (!acceptedPaths.has(url.pathname) || url.search || url.hash) return null;
    return event.pubkey;
  } catch {
    return null;
  }
}

export interface RegistrationServerHooks {
  /** Operator proof-of-delivery; required for the authenticated /test-send route. */
  sendTest?: (pubkey: string) => Promise<TestSendReport>;
  /** Push health is independent of paint-view reads. */
  pushHealth?: () => { readonly ok: boolean; readonly reason?: string };
  /** One aligned release identity plus the daemon fleet's READY records. */
  releaseStatus?: () =>
    | Promise<{
        readonly version?: string;
        readonly sourceSha?: string;
        readonly daemons: readonly DaemonReleaseFleetEntry[];
      }>
    | {
        readonly version?: string;
        readonly sourceSha?: string;
        readonly daemons: readonly DaemonReleaseFleetEntry[];
      };
  /** Workflow/operator credential for querying a different identity's device receipt. */
  otaReceiptAdminToken?: string;
  indexer?: {
    readonly publicOrigin: string;
    readonly now?: () => number;
    readonly readWorkspaces: (pubkey: string) => Promise<WorkspaceListView>;
    readonly readWorkspace: (workspaceId: string, pubkey: string) => Promise<WorkspaceView | null>;
    readonly readChats: (workspaceId: string, pubkey: string) => Promise<ChatListView | null>;
    readonly readAgent: (
      workspaceId: string,
      agentPubkey: string,
      pubkey: string,
    ) => Promise<AgentDetailView | null>;
    readonly readRoom: (roomId: string, pubkey: string) => Promise<RoomView | null>;
    readonly readCorners: (roomId: string, pubkey: string) => Promise<CornerListView | null>;
    readonly readHistory: (
      roomId: string,
      pubkey: string,
      before?: { readonly createdAt: number; readonly id: string },
    ) => Promise<RoomHistoryView | null>;
    readonly readInvite: (tokenHash: string, readerPubkey: string) => Promise<InviteView | null>;
    readonly claimAgentPairing: (
      tokenHash: string,
      agentPubkey: string,
      options: { readonly inheritInviterRooms: boolean },
    ) => Promise<AgentPairingClaimView | null>;
    readonly abandonAgentPairing: (tokenHash: string, agentPubkey: string) => Promise<boolean>;
    readonly log?: (line: string) => void;
  };
}

const CHANNEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INVITE_TOKEN = /^bzi_[0-9a-f]{64}$/;
const AGENT_PAIRING_CODE = /^BUZZ-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const AGENT_PAIRING_ROOM_ROLLBACK_CAPABILITY = 'pairing-room-rollback';
const PUBKEY = /^[0-9a-f]{64}$/;
const PRIVATE_HEADERS = {
  'cache-control': 'private, no-store',
  vary: 'Authorization',
} as const;

function logIndexer(indexer: NonNullable<RegistrationServerHooks['indexer']>, line: string): void {
  try {
    indexer.log?.(line);
  } catch {}
}

function matchesPublicOrigin(request: IncomingMessage, publicOrigin: string): boolean {
  const forwardedProtocol = request.headers['x-forwarded-proto'];
  if (forwardedProtocol === undefined) return true;
  if (Array.isArray(forwardedProtocol)) return false;
  const expected = new URL(publicOrigin);
  return (
    forwardedProtocol.toLowerCase() === expected.protocol.slice(0, -1) &&
    request.headers.host?.toLowerCase() === expected.host.toLowerCase()
  );
}

/**
 * Authenticate one indexer surface request against its exact public method and
 * path. The caller retains its route-specific missing-resource semantics.
 */
function authenticateIndexerRequest(
  request: IncomingMessage,
  response: ServerResponse,
  indexer: NonNullable<RegistrationServerHooks['indexer']>,
  method: string,
  path: string,
): string | null {
  if (!matchesPublicOrigin(request, indexer.publicOrigin)) {
    json(response, 401, { error: 'valid_identity_authorization_required' }, PRIVATE_HEADERS);
    return null;
  }
  const auth = verifyNip98Header(
    request.headers.authorization,
    `${indexer.publicOrigin}${path}`,
    method,
    new Date(indexer.now?.() ?? Date.now()),
    60,
  );
  if (!auth.ok) {
    json(response, 401, { error: 'valid_identity_authorization_required' }, PRIVATE_HEADERS);
    return null;
  }
  return auth.pubkey;
}

type IndexRoute =
  | { readonly kind: 'workspaces' }
  | { readonly kind: 'workspace'; readonly workspaceId: string }
  | { readonly kind: 'chats'; readonly workspaceId: string }
  | { readonly kind: 'agent'; readonly workspaceId: string; readonly agentPubkey: string }
  | { readonly kind: 'room'; readonly roomId: string }
  | { readonly kind: 'corners'; readonly roomId: string }
  | {
      readonly kind: 'history';
      readonly roomId: string;
      readonly before?: { readonly createdAt: number; readonly id: string };
    };

function exactUuid(value: string): string | null {
  const lower = value.toLowerCase();
  return CHANNEL_ID.test(value) && value === lower ? lower : null;
}

function indexRoute(requestUrl: string): IndexRoute | null {
  let url: URL;
  try {
    url = new URL(requestUrl, 'http://indexer.invalid');
  } catch {
    return null;
  }
  if (url.pathname === '/workspaces' && !url.search) return { kind: 'workspaces' };
  const workspaceAgent = url.pathname.match(/^\/workspace\/([^/]+)\/agents\/([^/]+)$/);
  if (workspaceAgent && !url.search) {
    const workspaceId = exactUuid(workspaceAgent[1]!);
    const agentPubkey = workspaceAgent[2]!;
    return workspaceId && PUBKEY.test(agentPubkey)
      ? { kind: 'agent', workspaceId, agentPubkey }
      : null;
  }
  const workspaceChats = url.pathname.match(/^\/workspace\/([^/]+)\/chats$/);
  if (workspaceChats && !url.search) {
    const workspaceId = exactUuid(workspaceChats[1]!);
    return workspaceId ? { kind: 'chats', workspaceId } : null;
  }
  const workspace = url.pathname.match(/^\/workspace\/([^/]+)$/);
  if (workspace && !url.search) {
    const workspaceId = exactUuid(workspace[1]!);
    return workspaceId ? { kind: 'workspace', workspaceId } : null;
  }
  const corners = url.pathname.match(/^\/room\/([^/]+)\/corners$/);
  if (corners && !url.search) {
    const roomId = exactUuid(corners[1]!);
    return roomId ? { kind: 'corners', roomId } : null;
  }
  const history = url.pathname.match(/^\/room\/([^/]+)\/messages$/);
  if (history) {
    const roomId = exactUuid(history[1]!);
    if (!roomId || [...url.searchParams.keys()].some((key) => key !== 'before')) return null;
    const rawBefore = url.searchParams.get('before');
    if (!rawBefore) return url.search ? null : { kind: 'history', roomId };
    const match = rawBefore.match(/^(\d+),([0-9a-f]{64})$/);
    if (!match) return null;
    const createdAt = Number(match[1]);
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) return null;
    return { kind: 'history', roomId, before: { createdAt, id: match[2]! } };
  }
  const room = url.pathname.match(/^\/room\/([^/]+)$/);
  if (room && !url.search) {
    const roomId = exactUuid(room[1]!);
    return roomId ? { kind: 'room', roomId } : null;
  }
  return null;
}

async function indexView(
  indexer: NonNullable<RegistrationServerHooks['indexer']>,
  route: IndexRoute,
  pubkey: string,
): Promise<unknown | null> {
  switch (route.kind) {
    case 'workspaces':
      return indexer.readWorkspaces(pubkey);
    case 'workspace':
      return indexer.readWorkspace(route.workspaceId, pubkey);
    case 'chats':
      return indexer.readChats(route.workspaceId, pubkey);
    case 'agent':
      return indexer.readAgent(route.workspaceId, route.agentPubkey, pubkey);
    case 'room':
      return indexer.readRoom(route.roomId, pubkey);
    case 'corners':
      return indexer.readCorners(route.roomId, pubkey);
    case 'history':
      return indexer.readHistory(route.roomId, pubkey, route.before);
  }
}

export function createRegistrationServer(
  registry: TokenRegistry,
  hooks: RegistrationServerHooks = {},
) {
  const inviteRate = new Map<string, { count: number; resetAt: number }>();
  return createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/health') {
        const pushHealth = hooks.pushHealth?.() ?? { ok: true };
        const release = await hooks.releaseStatus?.();
        json(response, pushHealth.ok ? 200 : 503, {
          ok: pushHealth.ok,
          ...(pushHealth.reason ? { reason: pushHealth.reason } : {}),
          registeredPubkeys: registry.pubkeyCount,
          registeredDevices: registry.tokenCount,
          ...(release
            ? {
                release: {
                  version: release.version ?? null,
                  sourceSha: release.sourceSha ?? null,
                },
                daemons: release.daemons,
              }
            : {}),
        });
        return;
      }

      if (request.method === 'POST' && request.url === '/invite/resolve' && hooks.indexer) {
        const startedAt = performance.now();
        let status = 500;
        try {
          const pubkey = authenticateIndexerRequest(
            request,
            response,
            hooks.indexer,
            'POST',
            '/invite/resolve',
          );
          if (!pubkey) {
            status = 401;
            return;
          }
          const now = hooks.indexer.now?.() ?? Date.now();
          const address = request.socket.remoteAddress ?? 'unknown';
          const rateKey = `${pubkey}:${address}`;
          const current = inviteRate.get(rateKey);
          const bucket =
            !current || current.resetAt <= now ? { count: 0, resetAt: now + 60_000 } : current;
          bucket.count += 1;
          inviteRate.set(rateKey, bucket);
          if (bucket.count > 20) {
            status = 429;
            json(response, status, { error: 'rate_limited' }, PRIVATE_HEADERS);
            return;
          }
          let body: unknown;
          try {
            body = await readJson(request);
          } catch {
            status = 404;
            json(response, status, { error: 'not_found' }, PRIVATE_HEADERS);
            return;
          }
          const token =
            body && typeof body === 'object' && 'token' in body
              ? (body as { token?: unknown }).token
              : undefined;
          if (typeof token !== 'string' || !INVITE_TOKEN.test(token)) {
            status = 404;
            json(response, status, { error: 'not_found' }, PRIVATE_HEADERS);
            return;
          }
          const tokenHash = createHash('sha256').update(token).digest('hex');
          const view = await hooks.indexer.readInvite(tokenHash, pubkey);
          status = view ? 200 : 404;
          json(response, status, view ?? { error: 'not_found' }, PRIVATE_HEADERS);
          return;
        } catch (error) {
          status = 503;
          const detail = error instanceof Error ? error.message : String(error);
          logIndexer(hooks.indexer, `[indexer] invite failed error=${JSON.stringify(detail)}`);
          if (response.headersSent) response.destroy();
          else json(response, status, { error: 'temporarily_unavailable' }, PRIVATE_HEADERS);
          return;
        } finally {
          logIndexer(
            hooks.indexer,
            `[indexer] request surface=invite status=${status} duration_ms=${Math.round(performance.now() - startedAt)}`,
          );
        }
      }

      if (request.method === 'POST' && request.url === '/agent-pairing/claim' && hooks.indexer) {
        const startedAt = performance.now();
        let status = 500;
        try {
          const pubkey = authenticateIndexerRequest(
            request,
            response,
            hooks.indexer,
            'POST',
            '/agent-pairing/claim',
          );
          if (!pubkey) {
            status = 401;
            return;
          }
          let body: unknown;
          try {
            body = await readJson(request);
          } catch {
            status = 404;
            json(response, status, { error: 'not_found' }, PRIVATE_HEADERS);
            return;
          }
          const rawCode =
            body && typeof body === 'object' && 'code' in body
              ? (body as { code?: unknown }).code
              : undefined;
          const rawCapabilities =
            body && typeof body === 'object' && 'capabilities' in body
              ? (body as { capabilities?: unknown }).capabilities
              : undefined;
          const code = typeof rawCode === 'string' ? rawCode.trim().toUpperCase() : '';
          if (!AGENT_PAIRING_CODE.test(code)) {
            status = 404;
            json(response, status, { error: 'not_found' }, PRIVATE_HEADERS);
            return;
          }
          const tokenHash = createHash('sha256').update(code).digest('hex');
          const inheritInviterRooms =
            Array.isArray(rawCapabilities) &&
            rawCapabilities.includes(AGENT_PAIRING_ROOM_ROLLBACK_CAPABILITY);
          const claim = await hooks.indexer.claimAgentPairing(tokenHash, pubkey, {
            inheritInviterRooms,
          });
          status = claim ? 200 : 404;
          json(response, status, claim ?? { error: 'not_found' }, PRIVATE_HEADERS);
          return;
        } catch (error) {
          status = 503;
          const detail = error instanceof Error ? error.message : String(error);
          logIndexer(
            hooks.indexer,
            `[indexer] agent pairing claim failed error=${JSON.stringify(detail)}`,
          );
          if (response.headersSent) response.destroy();
          else json(response, status, { error: 'temporarily_unavailable' }, PRIVATE_HEADERS);
          return;
        } finally {
          logIndexer(
            hooks.indexer,
            `[indexer] request surface=agent-pairing-claim status=${status} duration_ms=${Math.round(performance.now() - startedAt)}`,
          );
        }
      }

      if (request.method === 'POST' && request.url === '/agent-pairing/abandon' && hooks.indexer) {
        const startedAt = performance.now();
        let status = 500;
        try {
          const pubkey = authenticateIndexerRequest(
            request,
            response,
            hooks.indexer,
            'POST',
            '/agent-pairing/abandon',
          );
          if (!pubkey) {
            status = 401;
            return;
          }
          let body: unknown;
          try {
            body = await readJson(request);
          } catch {
            status = 404;
            json(response, status, { error: 'not_found' }, PRIVATE_HEADERS);
            return;
          }
          const rawCode =
            body && typeof body === 'object' && 'code' in body
              ? (body as { code?: unknown }).code
              : undefined;
          const code = typeof rawCode === 'string' ? rawCode.trim().toUpperCase() : '';
          if (!AGENT_PAIRING_CODE.test(code)) {
            status = 404;
            json(response, status, { error: 'not_found' }, PRIVATE_HEADERS);
            return;
          }
          const abandoned = await hooks.indexer.abandonAgentPairing(
            createHash('sha256').update(code).digest('hex'),
            pubkey,
          );
          status = abandoned ? 200 : 404;
          const result: AgentPairingAbandonView = { abandoned };
          json(response, status, abandoned ? result : { error: 'not_found' }, PRIVATE_HEADERS);
          return;
        } catch (error) {
          status = 503;
          const detail = error instanceof Error ? error.message : String(error);
          logIndexer(
            hooks.indexer,
            `[indexer] agent pairing abandon failed error=${JSON.stringify(detail)}`,
          );
          if (response.headersSent) response.destroy();
          else json(response, status, { error: 'temporarily_unavailable' }, PRIVATE_HEADERS);
          return;
        } finally {
          logIndexer(
            hooks.indexer,
            `[indexer] request surface=agent-pairing-abandon status=${status} duration_ms=${Math.round(performance.now() - startedAt)}`,
          );
        }
      }

      if (request.method === 'GET' && request.url && hooks.indexer) {
        const route = indexRoute(request.url);
        const indexNamespace = /^\/(?:workspaces(?:[/?]|$)|workspace\/|room\/|invite\/)/.test(
          request.url,
        );
        if (!route && indexNamespace) {
          json(response, 404, { error: 'not_found' }, PRIVATE_HEADERS);
          return;
        }
        if (route) {
          const startedAt = performance.now();
          let status = 500;
          try {
            const pubkey = authenticateIndexerRequest(
              request,
              response,
              hooks.indexer,
              'GET',
              request.url,
            );
            if (!pubkey) {
              status = 401;
              return;
            }
            const view = await indexView(hooks.indexer, route, pubkey);
            if (!view) {
              status = 404;
              json(response, status, { error: 'not_found' }, PRIVATE_HEADERS);
              return;
            }
            status = 200;
            json(response, status, view, PRIVATE_HEADERS);
            return;
          } catch (error) {
            status = 503;
            let detail = 'unknown indexer failure';
            try {
              detail = error instanceof Error ? error.message : String(error);
            } catch {}
            logIndexer(
              hooks.indexer,
              `[indexer] get failed surface=${route.kind} error=${JSON.stringify(detail)}`,
            );
            if (response.headersSent) response.destroy();
            else json(response, status, { error: 'temporarily_unavailable' }, PRIVATE_HEADERS);
            return;
          } finally {
            logIndexer(
              hooks.indexer,
              `[indexer] get surface=${route.kind} status=${status} duration_ms=${Math.round(performance.now() - startedAt)}`,
            );
          }
        }
      }

      if (request.method === 'POST' && request.url === '/registrations') {
        const body = await readJson(request);
        if (!body || typeof body !== 'object') throw new Error('expected JSON object');
        const { pubkey, token, platform, environment } = body as Record<string, unknown>;
        if (platform !== 'android') throw new Error('only android registrations are supported');
        if (typeof pubkey !== 'string' || !TokenRegistry.validPubkey(pubkey))
          throw new Error('invalid pubkey');
        if (typeof token !== 'string' || !TokenRegistry.validToken(token))
          throw new Error('invalid FCM token');
        if (environment !== undefined && typeof environment !== 'string') {
          throw new Error('invalid device environment');
        }
        if (environment && NON_PRODUCTION_ENVIRONMENTS.has(environment.toLowerCase())) {
          console.log(
            `[push] ignored non-production device pubkey=${pubkey.slice(0, 12)}… environment=${environment.toLowerCase()}`,
          );
          json(response, 202, { registered: false, ignored: 'non-production-device' });
          return;
        }
        await registry.register(pubkey, token);
        console.log(
          `[push] device registered pubkey=${pubkey.slice(0, 12)}… devices=${registry.tokenCount}`,
        );
        json(response, 201, { registered: true });
        return;
      }

      if (request.method === 'POST' && request.url === '/update-receipts') {
        const body = await readJson(request);
        if (!body || typeof body !== 'object') throw new Error('expected JSON object');
        const {
          pubkey,
          deviceId,
          updateId,
          channel,
          group,
          runtimeVersion,
          releaseVersion,
          sourceSha,
          environment,
        } = body as Record<string, unknown>;
        if (typeof pubkey !== 'string' || !TokenRegistry.validPubkey(pubkey)) {
          throw new Error('invalid pubkey');
        }
        if (authenticatedPubkey(request) !== pubkey) {
          json(response, 401, { error: 'valid identity authorization required' }, PRIVATE_HEADERS);
          return;
        }
        const nullableString = (value: unknown): string | null | undefined =>
          value === null ? null : typeof value === 'string' ? value : undefined;
        const parsedDeviceId = typeof deviceId === 'string' ? deviceId : '';
        const parsedUpdateId = nullableString(updateId);
        const parsedChannel = nullableString(channel);
        const parsedGroup = nullableString(group);
        const parsedRuntimeVersion = nullableString(runtimeVersion);
        const parsedReleaseVersion = nullableString(releaseVersion);
        const parsedSourceSha = nullableString(sourceSha);
        const parsedEnvironment =
          environment === 'physical'
            ? ('physical' as const)
            : environment === 'emulator'
              ? ('emulator' as const)
              : undefined;
        if (
          parsedUpdateId === undefined ||
          parsedChannel === undefined ||
          parsedGroup === undefined ||
          parsedRuntimeVersion === undefined ||
          parsedReleaseVersion === undefined ||
          parsedSourceSha === undefined ||
          parsedEnvironment === undefined
        ) {
          throw new Error('invalid update receipt');
        }
        const stored = await registry.recordUpdateReceipt({
          pubkey,
          deviceId: parsedDeviceId,
          updateId: parsedUpdateId,
          channel: parsedChannel,
          group: parsedGroup,
          runtimeVersion: parsedRuntimeVersion,
          releaseVersion: parsedReleaseVersion,
          sourceSha: parsedSourceSha,
          environment: parsedEnvironment,
        });
        json(response, 201, { recorded: true, receipt: stored }, PRIVATE_HEADERS);
        return;
      }

      const receiptQuery = request.url?.match(/^\/update-receipts\/([0-9a-f]{64})$/);
      if (request.method === 'GET' && receiptQuery) {
        const pubkey = receiptQuery[1]!;
        const bearer = request.headers.authorization?.startsWith('Bearer ')
          ? request.headers.authorization.slice('Bearer '.length)
          : null;
        const operatorAuthorized =
          Boolean(hooks.otaReceiptAdminToken) && bearer === hooks.otaReceiptAdminToken;
        if (!operatorAuthorized && authenticatedPubkey(request) !== pubkey) {
          json(response, 401, { error: 'valid receipt authorization required' }, PRIVATE_HEADERS);
          return;
        }
        json(
          response,
          200,
          { pubkey, devices: registry.receiptsForPubkey(pubkey) },
          PRIVATE_HEADERS,
        );
        return;
      }

      if (request.method === 'POST' && request.url === '/test-send') {
        const body = await readJson(request);
        if (!body || typeof body !== 'object') throw new Error('expected JSON object');
        const { pubkey } = body as Record<string, unknown>;
        if (typeof pubkey !== 'string' || !TokenRegistry.validPubkey(pubkey)) {
          throw new Error('invalid pubkey');
        }
        // Same NIP-98 identity posture as DELETE /registrations: only the bound
        // identity may prove delivery to its own devices, so a leaked endpoint
        // can never spam someone else's phone.
        if (authenticatedPubkey(request) !== pubkey) {
          json(response, 401, { error: 'valid identity authorization required' });
          return;
        }
        if (!hooks.sendTest || hooks.pushHealth?.().ok === false) {
          json(response, 503, { error: 'test-send unavailable' });
          return;
        }
        const report = await hooks.sendTest(pubkey);
        json(response, 200, report);
        return;
      }

      if (request.method === 'DELETE' && request.url === '/registrations') {
        const body = await readJson(request);
        if (!body || typeof body !== 'object') throw new Error('expected JSON object');
        const { pubkey, token } = body as Record<string, unknown>;
        if (typeof pubkey !== 'string' || !TokenRegistry.validPubkey(pubkey)) {
          throw new Error('invalid pubkey');
        }
        if (authenticatedPubkey(request) !== pubkey) {
          json(response, 401, { error: 'valid identity authorization required' });
          return;
        }
        if (typeof token !== 'string' || !TokenRegistry.validToken(token)) {
          throw new Error('invalid FCM token');
        }
        await registry.unregister(pubkey, token);
        json(response, 200, { registered: false });
        return;
      }

      json(response, 404, { error: 'not found' });
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : 'invalid request' });
    }
  });
}
