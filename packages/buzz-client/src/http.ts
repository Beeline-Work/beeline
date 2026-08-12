/**
 * HTTP bridge client for the Buzz relay.
 *
 * Publish: POST /events  (signed event JSON)
 * Query:   POST /query   (array of NIP-01 filters → event array)
 *
 * Local open stack keeps the X-Pubkey fallback (BUZZ_REQUIRE_AUTH_TOKEN=false).
 * Production uses NIP-98 auth bound to the exact request URL and method.
 */
import { nip98AuthHeader, type NostrEvent } from '@beeline/nostr';
import type { Identity, PublishResult } from './types.js';

export interface HttpBridgeOptions {
  baseUrl: string;
  host: string;
  /** Identity used only to sign short-lived, host-bound NIP-98 request auth. */
  identity?: Pick<Identity, 'secretKey' | 'publicKey'>;
}

/** HTTP bridge options whose signing identity cannot be omitted accidentally. */
export interface AuthenticatedHttpBridgeOptions extends HttpBridgeOptions {
  identity: Pick<Identity, 'secretKey' | 'publicKey'>;
}

const IMMUTABLE_CREATE_CACHE_TTL_MS = 5 * 60_000;
const CREATE_SCAN_CACHE_TTL_MS = 500;
const QUERY_CACHE_MAX_ENTRIES = 200;

type QueryCacheEntry = {
  expiresAt: number;
  result: Promise<readonly NostrEvent[]>;
};

const queryCache = new Map<string, QueryCacheEntry>();
const fetchIds = new WeakMap<object, number>();
let nextFetchId = 1;

function currentFetchId(): number {
  const fetchFunction = fetch as unknown as object;
  const existing = fetchIds.get(fetchFunction);
  if (existing) return existing;
  const assigned = nextFetchId++;
  fetchIds.set(fetchFunction, assigned);
  return assigned;
}

function queryCachePrefix(opts: HttpBridgeOptions, pubkey: string): string {
  return `${opts.baseUrl.replace(/\/$/, '')}\u0000${opts.host}\u0000${pubkey}\u0000`;
}

function invalidateQueryCache(opts: HttpBridgeOptions, pubkey: string): void {
  const prefix = queryCachePrefix(opts, pubkey);
  for (const key of queryCache.keys()) {
    if (key.startsWith(prefix)) queryCache.delete(key);
  }
}

function queryCacheTtl(filters: Record<string, unknown>[], events: readonly NostrEvent[]): number {
  if (filters.length !== 1) return 0;
  const filter = filters[0]!;
  const kinds = Array.isArray(filter.kinds) ? filter.kinds : [];
  if (kinds.length !== 1 || kinds[0] !== 9_007) return 0;
  const channelIds = Array.isArray(filter['#h']) ? filter['#h'] : [];
  if (channelIds.length === 1 && events.length > 0) return IMMUTABLE_CREATE_CACHE_TTL_MS;
  return CREATE_SCAN_CACHE_TTL_MS;
}

function bridgeHeaders(
  opts: HttpBridgeOptions,
  pubkey: string,
  url: string,
  method: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    host: opts.host,
    'x-pubkey': pubkey,
  };
  if (opts.identity) {
    headers.authorization = nip98AuthHeader(
      opts.identity.secretKey,
      opts.identity.publicKey,
      url,
      method,
    );
  }
  return headers;
}

/** Publish a signed event via the HTTP bridge. Throws on non-2xx. */
export async function publishEvent(
  opts: HttpBridgeOptions,
  event: NostrEvent,
): Promise<PublishResult> {
  if (opts.identity && opts.identity.publicKey !== event.pubkey) {
    throw new Error(`publishEvent kind=${event.kind} signer does not match relay auth identity`);
  }
  const url = `${opts.baseUrl}/events`;
  const method = 'POST';
  const res = await fetch(url, {
    method,
    headers: bridgeHeaders(opts, event.pubkey, url, method),
    body: JSON.stringify(event),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep raw */
  }
  if (!res.ok) {
    throw new Error(`publishEvent kind=${event.kind} failed: HTTP ${res.status} ${text}`);
  }
  const accepted =
    typeof body === 'object' && body !== null && 'accepted' in body
      ? Boolean((body as { accepted: unknown }).accepted)
      : true;
  if (!accepted) {
    throw new Error(`publishEvent kind=${event.kind} was not accepted: ${text}`);
  }
  invalidateQueryCache(opts, event.pubkey);
  return { status: res.status, accepted, body };
}

/** Query events. `queryPubkey` is the reader identity (X-Pubkey). */
export async function queryEvents(
  opts: HttpBridgeOptions,
  filters: Record<string, unknown>[],
  queryPubkey: string,
): Promise<NostrEvent[]> {
  const cacheKey = `${queryCachePrefix(opts, queryPubkey)}${currentFetchId()}\u0000${JSON.stringify(filters)}`;
  const cached = queryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result.then((events) => [...events]);
  }
  if (cached) queryCache.delete(cacheKey);

  const url = `${opts.baseUrl}/query`;
  const method = 'POST';
  const result = (async (): Promise<readonly NostrEvent[]> => {
    const res = await fetch(url, {
      method,
      headers: bridgeHeaders(opts, queryPubkey, url, method),
      body: JSON.stringify(filters),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`queryEvents failed: HTTP ${res.status} ${text}`);
    }
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error(`queryEvents: expected array, got ${text.slice(0, 200)}`);
    }
    return parsed as NostrEvent[];
  })();

  const entry: QueryCacheEntry = { expiresAt: Number.POSITIVE_INFINITY, result };
  queryCache.set(cacheKey, entry);
  if (queryCache.size > QUERY_CACHE_MAX_ENTRIES) {
    const oldestKey = queryCache.keys().next().value;
    if (oldestKey) queryCache.delete(oldestKey);
  }

  try {
    const events = await result;
    const ttl = queryCacheTtl(filters, events);
    if (ttl > 0) entry.expiresAt = Date.now() + ttl;
    else if (queryCache.get(cacheKey) === entry) queryCache.delete(cacheKey);
    return [...events];
  } catch (error) {
    if (queryCache.get(cacheKey) === entry) queryCache.delete(cacheKey);
    throw error;
  }
}

/** Probe relay health (used by live tests to soft-skip when down). */
export async function relayReachable(
  baseUrl: string,
  host: string,
  timeoutMs = 2500,
): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/health`, {
      headers: { host },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}
