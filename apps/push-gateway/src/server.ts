import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { NIP98_KIND, verifyEvent, verifyNip98Header, type NostrEvent } from '@beeline/nostr';
import {
  CHANNEL_SNAPSHOT_MAX_BYTES,
  guardStoredChannelSnapshotV1,
  snapshotViewerOverlay,
} from '@beeline/buzz-client';
import { TokenRegistry } from './registry.js';
import type { TestSendReport } from './gateway.js';
import type { SnapshotQueueStatus, ViewerSnapshotRow } from './snapshot-store.js';

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
  /** Push health is distinct from snapshot materialization/read health. */
  pushHealth?: () => { readonly ok: boolean; readonly reason?: string };
  snapshot?: {
    readonly publicOrigin: string;
    readonly maxLagMs?: number;
    readonly now?: () => number;
    readonly readForViewer: (
      channelId: string,
      pubkey: string,
    ) => Promise<ViewerSnapshotRow | null>;
    readonly claimNip98Event: (eventId: string) => Promise<boolean>;
    readonly status?: () => Promise<SnapshotQueueStatus & { readonly warmed?: boolean }>;
    readonly log?: (line: string) => void;
  };
}

const CHANNEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SNAPSHOT_PATH = /^\/snapshot\/channel\/([^/?#]+)$/;
const SNAPSHOT_PRIVATE_HEADERS = {
  'cache-control': 'private, no-store',
  vary: 'Authorization',
} as const;

function snapshotUnavailable(response: ServerResponse, reason: string): void {
  json(
    response,
    503,
    { error: 'snapshot_not_ready', reason },
    { ...SNAPSHOT_PRIVATE_HEADERS, 'retry-after': '1' },
  );
}

function logSnapshot(
  snapshot: NonNullable<RegistrationServerHooks['snapshot']>,
  line: string,
): void {
  try {
    snapshot.log?.(line);
  } catch {}
}

export function createRegistrationServer(
  registry: TokenRegistry,
  hooks: RegistrationServerHooks = {},
) {
  return createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/health') {
        const pushHealth = hooks.pushHealth?.() ?? { ok: true };
        json(response, pushHealth.ok ? 200 : 503, {
          ok: pushHealth.ok,
          ...(pushHealth.reason ? { reason: pushHealth.reason } : {}),
          registeredPubkeys: registry.pubkeyCount,
          registeredDevices: registry.tokenCount,
        });
        return;
      }

      if (request.method === 'GET' && request.url === '/snapshot/health' && hooks.snapshot) {
        const status = (await hooks.snapshot.status?.()) ?? {
          depth: 0,
          oldestDirtyAgeMs: 0,
        };
        json(response, 200, { ok: true, ...status });
        return;
      }

      const snapshotMatch = request.method === 'GET' ? request.url?.match(SNAPSHOT_PATH) : null;
      if (snapshotMatch && hooks.snapshot) {
        const startedAt = performance.now();
        let status = 500;
        const requestedChannelId = snapshotMatch[1]!;
        const channelId = requestedChannelId.toLowerCase();
        try {
          if (!CHANNEL_ID.test(requestedChannelId) || requestedChannelId !== channelId) {
            status = 404;
            json(response, status, { error: 'not_found' }, SNAPSHOT_PRIVATE_HEADERS);
            return;
          }
          const path = `/snapshot/channel/${channelId}`;
          const expectedUrl = `${hooks.snapshot.publicOrigin}${path}`;
          const auth = verifyNip98Header(
            request.headers.authorization,
            expectedUrl,
            'GET',
            new Date(hooks.snapshot.now?.() ?? Date.now()),
            60,
          );
          if (!auth.ok || !(await hooks.snapshot.claimNip98Event(auth.eventId))) {
            status = 401;
            json(
              response,
              status,
              { error: 'valid_identity_authorization_required' },
              SNAPSHOT_PRIVATE_HEADERS,
            );
            return;
          }
          const row = await hooks.snapshot.readForViewer(channelId, auth.pubkey);
          if (!row) {
            status = 404;
            json(response, status, { error: 'not_found' }, SNAPSHOT_PRIVATE_HEADERS);
            return;
          }
          if (!Object.hasOwn(row, 'payload') || !Object.hasOwn(row, 'digest')) {
            status = 503;
            snapshotUnavailable(response, 'missing');
            return;
          }
          if (row.lagMs > (hooks.snapshot.maxLagMs ?? 30_000)) {
            status = 503;
            snapshotUnavailable(response, 'stale');
            return;
          }
          const digest = typeof row.digest === 'string' ? row.digest : '';
          const stored = guardStoredChannelSnapshotV1(row.payload, channelId, digest);
          if (stored.status !== 'ready') {
            status = 503;
            snapshotUnavailable(response, 'incompatible_or_corrupt');
            return;
          }
          const view = {
            ...stored.payload,
            lagMs: row.lagMs,
            viewer: snapshotViewerOverlay(stored.payload, auth.pubkey),
            integrity: {
              algorithm: 'sha256' as const,
              scope: 'stored-channel-snapshot-v1' as const,
              digest,
            },
          };
          const serialized = `${JSON.stringify(view)}\n`;
          if (Buffer.byteLength(serialized) > CHANNEL_SNAPSHOT_MAX_BYTES) {
            status = 503;
            snapshotUnavailable(response, 'incompatible_or_corrupt');
            return;
          }
          status = 200;
          response.writeHead(status, {
            'content-type': 'application/json',
            ...SNAPSHOT_PRIVATE_HEADERS,
            'x-beeline-snapshot-schema': String(stored.payload.schemaVersion),
            'x-beeline-snapshot-projection': String(stored.payload.projectionVersion),
            'x-beeline-snapshot-integrity': digest,
          });
          response.end(serialized);
          return;
        } catch (error) {
          status = 503;
          let detail = 'unknown snapshot failure';
          try {
            detail = error instanceof Error ? error.message : String(error);
          } catch {}
          logSnapshot(
            hooks.snapshot,
            `[snapshot] get failed channel=${channelId} error=${JSON.stringify(detail)}`,
          );
          if (response.headersSent) response.destroy();
          else snapshotUnavailable(response, 'temporarily_unavailable');
          return;
        } finally {
          logSnapshot(
            hooks.snapshot,
            `[snapshot] get channel=${channelId} status=${status} duration_ms=${Math.round(performance.now() - startedAt)}`,
          );
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
