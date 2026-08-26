import { bytesToHex, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { signEvent, verifyEvent, type NostrEvent } from './events.js';

export const NIP98_KIND = 27235;

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Encode bytes as standard padded base64 without relying on Node's Buffer. */
function bytesToBase64(bytes: Uint8Array): string {
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const chunk = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);

    encoded += BASE64_ALPHABET[(chunk >>> 18) & 63];
    encoded += BASE64_ALPHABET[(chunk >>> 12) & 63];
    encoded += second === undefined ? '=' : BASE64_ALPHABET[(chunk >>> 6) & 63];
    encoded += third === undefined ? '=' : BASE64_ALPHABET[chunk & 63];
  }
  return encoded;
}

function base64ToBytes(value: string): Uint8Array | null {
  if (!value || value.length > 32_768 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  try {
    const decoded = atob(value);
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function asNostrEvent(value: unknown): NostrEvent | null {
  if (!value || typeof value !== 'object') return null;
  const event = value as Partial<NostrEvent>;
  if (
    typeof event.id !== 'string' ||
    !/^[0-9a-f]{64}$/.test(event.id) ||
    typeof event.pubkey !== 'string' ||
    !/^[0-9a-f]{64}$/.test(event.pubkey) ||
    typeof event.sig !== 'string' ||
    !/^[0-9a-f]{128}$/.test(event.sig) ||
    !Number.isSafeInteger(event.created_at) ||
    !Number.isSafeInteger(event.kind) ||
    !Array.isArray(event.tags) ||
    !event.tags.every(
      (tag) => Array.isArray(tag) && tag.every((entry) => typeof entry === 'string'),
    ) ||
    typeof event.content !== 'string'
  ) {
    return null;
  }
  if (event.tags.length > 32 || event.content.length > 16_384) return null;
  return event as NostrEvent;
}

function hasExactTag(event: NostrEvent, name: string, expected: string): boolean {
  const matches = event.tags.filter((tag) => tag[0] === name);
  return matches.length === 1 && matches[0]!.length === 2 && matches[0]![1] === expected;
}

export type Nip98Verification =
  | { readonly ok: true; readonly pubkey: string; readonly eventId: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Verify one exact NIP-98 request proof. The caller supplies the canonical
 * public URL; forwarded hosts and path aliases never participate in trust.
 */
export function verifyNip98Header(
  authorization: string | undefined,
  expectedUrl: string,
  method: string,
  now = new Date(),
  clockSkewSeconds = 60,
): Nip98Verification {
  if (!authorization?.startsWith('Nostr ')) {
    return { ok: false, reason: 'NIP-98 authentication required' };
  }
  const bytes = base64ToBytes(authorization.slice('Nostr '.length));
  if (!bytes) return { ok: false, reason: 'malformed NIP-98 authentication' };

  let parsed: unknown;
  try {
    const decoded = new TextDecoder().decode(bytes);
    if (decoded.length > 16_384) throw new Error('too large');
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    return { ok: false, reason: 'malformed NIP-98 authentication' };
  }
  const event = asNostrEvent(parsed);
  if (!event || event.kind !== NIP98_KIND || event.content !== '') {
    return { ok: false, reason: 'invalid NIP-98 event' };
  }
  if (
    event.tags.length !== 3 ||
    !hasExactTag(event, 'u', expectedUrl) ||
    !hasExactTag(event, 'method', method.toUpperCase())
  ) {
    return { ok: false, reason: 'NIP-98 request binding mismatch' };
  }
  const nonceTags = event.tags.filter((tag) => tag[0] === 'nonce');
  if (nonceTags.length !== 1 || nonceTags[0]!.length !== 2 || !nonceTags[0]![1]) {
    return { ok: false, reason: 'NIP-98 nonce required' };
  }
  const allowedTags = new Set(['u', 'method', 'nonce']);
  if (event.tags.some((tag) => !allowedTags.has(tag[0]!))) {
    return { ok: false, reason: 'unexpected NIP-98 tag' };
  }
  if (Math.abs(now.getTime() / 1_000 - event.created_at) > clockSkewSeconds) {
    return { ok: false, reason: 'stale NIP-98 authentication' };
  }
  if (!verifyEvent(event)) return { ok: false, reason: 'invalid NIP-98 signature' };
  return { ok: true, pubkey: event.pubkey, eventId: event.id };
}

/** Build a signed NIP-98 HTTP-auth event bound to one exact URL and method. */
export function buildNip98Event(
  secretKey: Uint8Array,
  pubkeyHex: string,
  url: string,
  method: string,
): NostrEvent {
  return signEvent(
    {
      pubkey: pubkeyHex,
      created_at: Math.floor(Date.now() / 1000),
      kind: NIP98_KIND,
      tags: [
        ['u', url],
        ['method', method.toUpperCase()],
        // A request can repeat within one second. Keep its signed event ID unique
        // so replay-protected relays do not reject the second valid request.
        ['nonce', bytesToHex(randomBytes(16))],
      ],
      content: '',
    },
    secretKey,
  );
}

/** Produce a React-Native-safe `Authorization: Nostr <base64>` value. */
export function nip98AuthHeader(
  secretKey: Uint8Array,
  pubkeyHex: string,
  url: string,
  method: string,
): string {
  const event = buildNip98Event(secretKey, pubkeyHex, url, method);
  return `Nostr ${bytesToBase64(utf8ToBytes(JSON.stringify(event)))}`;
}
