import { bytesToHex, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { signEvent, type NostrEvent } from './events.js';

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
