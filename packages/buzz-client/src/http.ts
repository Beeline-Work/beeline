import { nip98AuthHeader, type NostrEvent } from '@beeline/nostr';
import type { Identity } from './types.js';

export interface HttpBridgeOptions {
  baseUrl: string;
  host: string;
  /** Public origin authenticated by a Host-canonicalizing local proxy. */
  publicOrigin?: string;
  /** Identity used only to sign short-lived, host-bound NIP-98 request auth. */
  identity?: Pick<Identity, 'secretKey' | 'publicKey'>;
  /** Pre-signed exact-request NIP-98 proof, for a server relaying one authorized read. */
  authorization?: string | (() => string);
}

/** HTTP bridge options whose signing identity cannot be omitted accidentally. */
export interface AuthenticatedHttpBridgeOptions extends HttpBridgeOptions {
  identity: Pick<Identity, 'secretKey' | 'publicKey'>;
}

const IMMUTABLE_CREATE_CACHE_TTL_MS = 5 * 60_000;

// A genuinely-unscoped discovery scan (no #h/#d to narrow by) is exactly the
// read that benefits most from caching, since it's the most expensive shape
// on the relay. 500ms only dedupes same-tick callers; raised to smooth out
// repeated scans across a normal navigation burst while staying well short of
// the 5-minute immutable-data TTL above.
const CREATE_SCAN_CACHE_TTL_MS = 10_000;

const QUERY_CACHE_MAX_ENTRIES = 200;

// Retry transient 5xx and transport failures; explicit rejections fail fast.
const QUERY_MAX_ATTEMPTS = 3;

const QUERY_ATTEMPT_TIMEOUT_MS = 10_000;

const QUERY_RETRY_BASE_MS = 250;

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
  return `${opts.baseUrl.replace(/\/$/, '')}\u0000${opts.host}\u0000${opts.publicOrigin ?? ''}\u0000${pubkey}\u0000`;
}

function isNonRetryableQueryError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'nonRetryable' in error &&
    (error as { nonRetryable?: unknown }).nonRetryable === true
  );
}

function withQueryAttemptTimeout<T>(
  operation: Promise<T>,
  controller: AbortController,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`queryEvents timed out after ${QUERY_ATTEMPT_TIMEOUT_MS}ms`));
    }, QUERY_ATTEMPT_TIMEOUT_MS);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** One signed compatibility read with bounded retries, without cache or batching. */
export async function requestQueryEvents(
  opts: HttpBridgeOptions,
  filters: Record<string, unknown>[],
  queryPubkey: string,
): Promise<readonly NostrEvent[]> {
  const url = `${opts.baseUrl}/query`;
  const method = 'POST';
  for (let attempt = 1; attempt <= QUERY_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    try {
      const { res, text } = await withQueryAttemptTimeout(
        fetch(url, {
          method,
          headers: bridgeHeaders(opts, queryPubkey, url, method),
          body: JSON.stringify(filters),
          signal: controller.signal,
        }).then(async (res) => ({ res, text: await res.text() })),
        controller,
      );
      if (res.ok) {
        const parsed = JSON.parse(text) as unknown;
        if (!Array.isArray(parsed)) {
          throw new Error(`queryEvents: expected array, got ${text.slice(0, 200)}`);
        }
        return parsed as NostrEvent[];
      }
      if (res.status >= 500 && res.status <= 599 && attempt < QUERY_MAX_ATTEMPTS) {
        await sleep(QUERY_RETRY_BASE_MS * attempt);
        continue;
      }
      throw Object.assign(new Error(`queryEvents failed: HTTP ${res.status} ${text}`), {
        nonRetryable: true,
      });
    } catch (error) {
      if (isNonRetryableQueryError(error)) throw error;
      if (attempt === QUERY_MAX_ATTEMPTS) {
        throw new Error(`queryEvents failed after ${attempt} attempts: ${errorMessage(error)}`);
      }
      await sleep(QUERY_RETRY_BASE_MS * attempt);
      continue;
    }
  }
  throw new Error(`queryEvents exhausted ${QUERY_MAX_ATTEMPTS} attempts`);
}

function queryCacheTtl(filters: Record<string, unknown>[], events: readonly NostrEvent[]): number {
  if (filters.length !== 1) return 0;
  const filter = filters[0]!;
  const kinds = Array.isArray(filter.kinds) ? filter.kinds : [];
  if (kinds.length !== 1) return 0;
  if (kinds[0] === 9_007) {
    const channelIds = Array.isArray(filter['#h']) ? filter['#h'] : [];
    if (channelIds.length === 1 && events.length > 0) return IMMUTABLE_CREATE_CACHE_TTL_MS;
    return CREATE_SCAN_CACHE_TTL_MS;
  }
  if (kinds[0] === 39_000) {
    // Channel metadata (name/archived/visibility) is mutable but changes
    // rarely, and callers that need to react to a change already do so via
    // live signals (corner-status control messages, archive events) rather
    // than by re-polling this read — safe to give it the same scoped-and-seen
    // treatment as an immutable create event once a channel is known non-empty.
    const dIds = Array.isArray(filter['#d']) ? filter['#d'] : [];
    const hIds = Array.isArray(filter['#h']) ? filter['#h'] : [];
    if ((dIds.length === 1 || hIds.length === 1) && events.length > 0) {
      return IMMUTABLE_CREATE_CACHE_TTL_MS;
    }
  }
  return 0;
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
  if (opts.authorization) {
    headers.authorization =
      typeof opts.authorization === 'function' ? opts.authorization() : opts.authorization;
  } else if (opts.identity) {
    headers.authorization = nip98AuthHeader(
      opts.identity.secretKey,
      opts.identity.publicKey,
      authorizationUrl(opts, url),
      method,
    );
  }
  return headers;
}

function authorizationUrl(opts: HttpBridgeOptions, requestUrl: string): string {
  if (!opts.publicOrigin) return requestUrl;
  const request = new URL(requestUrl);
  return `${opts.publicOrigin.replace(/\/$/, '')}${request.pathname}${request.search}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

  const result = requestQueryEvents(opts, filters, queryPubkey);

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
