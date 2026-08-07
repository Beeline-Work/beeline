/**
 * Minimal HTTP client for the Buzz relay bridge.
 *
 * Publishing:   POST /events  (bare signed-event JSON body).
 * Reading:      POST /query   (array-of-filters body, returns event array).
 *
 * Auth: the stack runs with BUZZ_REQUIRE_AUTH_TOKEN=false, which enables the
 * `X-Pubkey: <hex>` dev-auth fallback (buzz-relay `api/bridge.rs`
 * verify_bridge_auth). The event is still fully schnorr-signed; X-Pubkey only
 * authorizes the *submission*, while ownership everywhere downstream uses the
 * event's own `pubkey`.
 */
import { BASE_URL, HOST } from './config.js';
import type { NostrEvent } from '@buzzy/nostr';

export interface SubmitResult {
  status: number;
  accepted: boolean;
  body: unknown;
}

/** Publish a signed event via the HTTP bridge. Throws on a non-2xx status. */
export async function publishEvent(event: NostrEvent): Promise<SubmitResult> {
  const res = await fetch(`${BASE_URL}/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      host: HOST,
      'x-pubkey': event.pubkey,
    },
    body: JSON.stringify(event),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep raw text */
  }
  if (!res.ok) {
    throw new Error(`publishEvent ${event.kind} failed: HTTP ${res.status} ${text}`);
  }
  const accepted =
    typeof body === 'object' && body !== null && 'accepted' in body
      ? Boolean((body as { accepted: unknown }).accepted)
      : true;
  return { status: res.status, accepted, body };
}

/** Query events via the HTTP bridge. `queryPubkey` is the reader identity (X-Pubkey). */
export async function queryEvents(
  filters: Record<string, unknown>[],
  queryPubkey: string,
): Promise<NostrEvent[]> {
  const res = await fetch(`${BASE_URL}/query`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      host: HOST,
      'x-pubkey': queryPubkey,
    },
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
