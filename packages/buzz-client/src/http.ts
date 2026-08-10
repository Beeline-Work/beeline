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
  return { status: res.status, accepted, body };
}

/** Query events. `queryPubkey` is the reader identity (X-Pubkey). */
export async function queryEvents(
  opts: HttpBridgeOptions,
  filters: Record<string, unknown>[],
  queryPubkey: string,
): Promise<NostrEvent[]> {
  const url = `${opts.baseUrl}/query`;
  const method = 'POST';
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
