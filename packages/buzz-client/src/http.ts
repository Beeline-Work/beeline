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
import {
  RelayPublishError,
  relayPublishErrorFromNetwork,
  relayPublishErrorFromResponse,
  relayPublishNegativeAck,
} from './relay-error.js';

export interface HttpBridgeOptions {
  baseUrl: string;
  host: string;
  /** Identity used only to sign short-lived, host-bound NIP-98 request auth. */
  identity?: Pick<Identity, 'secretKey' | 'publicKey'>;
  /** Pre-signed exact-request NIP-98 proof, for a server relaying one authorized read. */
  authorization?: string | (() => string);
  /** Coalesce same-turn reads into one multi-filter request. */
  batchQueries?: boolean;
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
const PUBLISH_MAX_ATTEMPTS = 4;
const PUBLISH_ATTEMPT_TIMEOUT_MS = 5_000;
const PUBLISH_RETRY_BASE_MS = 200;
const PUBLISH_RETRY_MAX_MS = 1_000;
// Same policy as apps/gate/src/relay.ts's createRelayClient().queryEvents,
// already proven in production: 5xx and transport/timeout errors are
// transient and retried; 4xx and explicit relay rejections fail fast.
const QUERY_MAX_ATTEMPTS = 3;
const QUERY_ATTEMPT_TIMEOUT_MS = 10_000;
const QUERY_RETRY_BASE_MS = 250;
const BATCHABLE_FILTER_KEYS = new Set(['ids', 'authors', 'kinds', 'since', 'until', 'limit']);

type QueryCacheEntry = {
  expiresAt: number;
  result: Promise<readonly NostrEvent[]>;
};

const queryCache = new Map<string, QueryCacheEntry>();
const fetchIds = new WeakMap<object, number>();
let nextFetchId = 1;

type PendingQuery = {
  opts: HttpBridgeOptions;
  filters: Record<string, unknown>[];
  queryPubkey: string;
  resolve: (events: readonly NostrEvent[]) => void;
  reject: (error: unknown) => void;
};

const pendingQueryBatches = new Map<string, PendingQuery[]>();

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

export function canPartitionFilter(filter: Record<string, unknown>): boolean {
  return Object.keys(filter).every((key) => BATCHABLE_FILTER_KEYS.has(key) || key.startsWith('#'));
}

function matchesPrefix(value: string, candidates: unknown): boolean {
  return (
    Array.isArray(candidates) &&
    candidates.some((candidate) => typeof candidate === 'string' && value.startsWith(candidate))
  );
}

function eventMatchesFilter(event: NostrEvent, filter: Record<string, unknown>): boolean {
  if (filter.ids !== undefined && !matchesPrefix(event.id, filter.ids)) return false;
  if (filter.authors !== undefined && !matchesPrefix(event.pubkey, filter.authors)) return false;
  if (
    filter.kinds !== undefined &&
    (!Array.isArray(filter.kinds) || !filter.kinds.includes(event.kind))
  ) {
    return false;
  }
  if (typeof filter.since === 'number' && event.created_at < filter.since) return false;
  if (typeof filter.until === 'number' && event.created_at > filter.until) return false;
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith('#')) continue;
    if (!Array.isArray(values)) return false;
    const tagName = key.slice(1);
    if (
      !event.tags.some(
        (tag) => tag[0] === tagName && typeof tag[1] === 'string' && values.includes(tag[1]),
      )
    ) {
      return false;
    }
  }
  return true;
}

export function selectQueryEvents(
  events: readonly NostrEvent[],
  filters: Record<string, unknown>[],
): readonly NostrEvent[] {
  const selected: NostrEvent[] = [];
  const seen = new Set<string>();
  for (const filter of filters) {
    const matching = events.filter((event) => eventMatchesFilter(event, filter));
    const limit = typeof filter.limit === 'number' ? Math.max(0, filter.limit) : matching.length;
    for (const event of matching.slice(0, limit)) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      selected.push(event);
    }
  }
  return selected;
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

/**
 * One `/query` POST with the retry/timeout policy above — no caching, no
 * same-tick batching (that's what the public `queryEvents()` adds on top).
 * Exported so a deliberately caching-free HTTP-only consumer (apps/gate's
 * `createRelayClient`) can share this exact policy instead of re-implementing
 * it, the same way it already delegates publishes to `publishEvent` below.
 */
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

async function flushQueryBatch(batchKey: string, batch: PendingQuery[]): Promise<void> {
  pendingQueryBatches.delete(batchKey);
  const first = batch[0];
  if (!first) return;
  const filters = batch.flatMap((query) => query.filters);
  try {
    const events = await requestQueryEvents(first.opts, filters, first.queryPubkey);
    for (const query of batch) query.resolve(selectQueryEvents(events, query.filters));
  } catch (error) {
    for (const query of batch) query.reject(error);
  }
}

function enqueueQueryEvents(
  opts: HttpBridgeOptions,
  filters: Record<string, unknown>[],
  queryPubkey: string,
): Promise<readonly NostrEvent[]> {
  const scope = `${queryCachePrefix(opts, queryPubkey)}${currentFetchId()}\u0000${opts.identity ? 'auth' : 'anon'}`;
  const batchKey = filters.every(canPartitionFilter)
    ? scope
    : `${scope}\u0000unpartitioned\u0000${JSON.stringify(filters)}`;
  return new Promise((resolve, reject) => {
    const existing = pendingQueryBatches.get(batchKey);
    const batch = existing ?? [];
    batch.push({ opts, filters, queryPubkey, resolve, reject });
    if (existing) return;
    pendingQueryBatches.set(batchKey, batch);
    queueMicrotask(() => void flushQueryBatch(batchKey, batch));
  });
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
      url,
      method,
    );
  }
  return headers;
}

function publishRetryDelayMs(failedAttempt: number): number {
  const exponential = Math.min(
    PUBLISH_RETRY_MAX_MS,
    PUBLISH_RETRY_BASE_MS * 2 ** (failedAttempt - 1),
  );
  return Math.round(exponential * (1 + Math.random() * 0.25));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logPublishRetry(
  event: NostrEvent,
  attempt: number,
  delayMs: number,
  reason: string,
): void {
  console.warn(
    `[buzz-client] publishEvent kind=${event.kind} id=${event.id.slice(0, 12)} ` +
      `attempt=${attempt}/${PUBLISH_MAX_ATTEMPTS} failed (${reason}); retrying in ${delayMs}ms`,
  );
}

/**
 * Publish a signed event via the HTTP bridge.
 *
 * A signed Nostr event has a stable id, so every retry sends the exact same
 * event. Relay id deduplication makes an ambiguous response safe to retry.
 * Only transport failures and HTTP 5xx responses are transient; 4xx responses
 * and explicit negative acknowledgements fail immediately.
 */
export async function publishEvent(
  opts: HttpBridgeOptions,
  event: NostrEvent,
): Promise<PublishResult> {
  if (opts.identity && opts.identity.publicKey !== event.pubkey) {
    throw new RelayPublishError({
      kind: 'CLIENT_VALIDATION',
      sentence: 'The message signer does not match the relay identity.',
      recoveryAction: 'Reload your identity before trying again.',
      retryable: false,
      eventKind: event.kind,
    });
  }
  const url = `${opts.baseUrl}/events`;
  const method = 'POST';
  const requestBody = JSON.stringify(event);

  for (let attempt = 1; attempt <= PUBLISH_MAX_ATTEMPTS; attempt++) {
    let res: Response;
    let text: string;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PUBLISH_ATTEMPT_TIMEOUT_MS);
    try {
      res = await fetch(url, {
        method,
        headers: bridgeHeaders(opts, event.pubkey, url, method),
        body: requestBody,
        signal: controller.signal,
      });
      text = await res.text();
    } catch (error) {
      if (attempt === PUBLISH_MAX_ATTEMPTS) {
        throw relayPublishErrorFromNetwork(error, event.kind);
      }
      const delayMs = publishRetryDelayMs(attempt);
      logPublishRetry(event, attempt, delayMs, `network/timeout: ${errorMessage(error)}`);
      await sleep(delayMs);
      continue;
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      if (res.status >= 500 && res.status <= 599 && attempt < PUBLISH_MAX_ATTEMPTS) {
        const delayMs = publishRetryDelayMs(attempt);
        logPublishRetry(event, attempt, delayMs, `HTTP ${res.status}`);
        await sleep(delayMs);
        continue;
      }
      throw relayPublishErrorFromResponse(res.status, text, event.kind);
    }

    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* keep raw */
    }
    const accepted =
      typeof body === 'object' && body !== null && 'accepted' in body
        ? Boolean((body as { accepted: unknown }).accepted)
        : true;
    if (!accepted) {
      throw relayPublishNegativeAck(text, event.kind);
    }
    invalidateQueryCache(opts, event.pubkey);
    return { status: res.status, accepted, body };
  }

  throw new RelayPublishError({
    kind: 'TRANSIENT',
    sentence: 'The relay is temporarily unavailable.',
    recoveryAction: 'Try sending the message again.',
    retryable: true,
    eventKind: event.kind,
  });
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

  // All reads started in one JS turn share one authenticated HTTP request. The
  // relay already accepts multiple NIP-01 filters; partition its union response
  // back to each caller so higher-level APIs keep their exact result semantics.
  const result = opts.batchQueries
    ? enqueueQueryEvents(opts, filters, queryPubkey)
    : requestQueryEvents(opts, filters, queryPubkey);

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
