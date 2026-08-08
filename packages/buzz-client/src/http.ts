/**
 * HTTP bridge client for the Buzz relay.
 *
 * Publish: POST /events  (signed event JSON)
 * Query:   POST /query   (array of NIP-01 filters → event array)
 *
 * Local open stack: X-Pubkey header (BUZZ_REQUIRE_AUTH_TOKEN=false).
 * Production: callers should upgrade to NIP-98 host-bound auth; Host must match.
 */
import type { NostrEvent } from '@buzzy/nostr';
import type { PublishResult } from './types.js';

export interface HttpBridgeOptions {
  baseUrl: string;
  host: string;
}

function bridgeHeaders(host: string, pubkey: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    host,
    'x-pubkey': pubkey,
  };
}

/** Publish a signed event via the HTTP bridge. Throws on non-2xx. */
export async function publishEvent(
  opts: HttpBridgeOptions,
  event: NostrEvent,
): Promise<PublishResult> {
  const res = await fetch(`${opts.baseUrl}/events`, {
    method: 'POST',
    headers: bridgeHeaders(opts.host, event.pubkey),
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
  return { status: res.status, accepted, body };
}

/** Query events. `queryPubkey` is the reader identity (X-Pubkey). */
export async function queryEvents(
  opts: HttpBridgeOptions,
  filters: Record<string, unknown>[],
  queryPubkey: string,
): Promise<NostrEvent[]> {
  const res = await fetch(`${opts.baseUrl}/query`, {
    method: 'POST',
    headers: bridgeHeaders(opts.host, queryPubkey),
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
}

/** Probe relay health (used by live tests to soft-skip when down). */
export async function relayReachable(baseUrl: string, host: string, timeoutMs = 2500): Promise<boolean> {
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
