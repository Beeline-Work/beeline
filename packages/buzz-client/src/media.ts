import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import type { HttpBridgeOptions } from './http.js';
import type { MediaBlob } from './types.js';

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function bytesToBase64(bytes: Uint8Array): string {
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index]!;
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    output += BASE64[a >> 2];
    output += BASE64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    output += b === undefined ? '=' : BASE64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    output += c === undefined ? '=' : BASE64[c & 63];
  }
  return output;
}

export function buildMediaUploadAuthorization(
  http: HttpBridgeOptions & { identity: NonNullable<HttpBridgeOptions['identity']> },
  sha256Hex: string,
  createdAt = Math.floor(Date.now() / 1000),
): NostrEvent {
  return signEvent(
    {
      pubkey: http.identity.publicKey,
      created_at: createdAt,
      kind: 24242,
      tags: [
        ['t', 'upload'],
        ['x', sha256Hex],
        ['expiration', String(createdAt + 300)],
        ['server', http.host],
      ],
      content: 'Upload avatar',
    },
    http.identity.secretKey,
  );
}

export async function uploadMedia(
  http: HttpBridgeOptions & { identity: NonNullable<HttpBridgeOptions['identity']> },
  bytes: Uint8Array,
  mimeType: string,
): Promise<MediaBlob> {
  if (!bytes.byteLength) throw new Error('media upload is empty');
  if (!mimeType.startsWith('image/')) throw new Error('avatar media must be an image');
  const hash = bytesToHex(sha256(bytes));
  const authorization = buildMediaUploadAuthorization(http, hash);
  const authorizationJson = JSON.stringify(authorization);
  const body = new Uint8Array(bytes.byteLength);
  body.set(bytes);
  const response = await fetch(`${http.baseUrl.replace(/\/$/, '')}/upload`, {
    method: 'PUT',
    headers: {
      Authorization: `Nostr ${bytesToBase64(utf8ToBytes(authorizationJson))}`,
      'Content-Type': mimeType,
      'X-SHA-256': hash,
    },
    body,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`media upload failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }
  const value = (await response.json()) as Partial<MediaBlob>;
  if (typeof value.url !== 'string' || value.sha256 !== hash || typeof value.size !== 'number')
    throw new Error('media upload returned an invalid descriptor');
  return value as MediaBlob;
}
