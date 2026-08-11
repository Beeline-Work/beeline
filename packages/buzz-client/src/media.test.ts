import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyEvent, type NostrEvent } from '@beeline/nostr';
import { createIdentity } from './identity.js';
import { uploadMedia } from './media.js';

const identity = createIdentity('media-test');
const http = { baseUrl: 'https://relay.example', host: 'relay.example', identity };

function decodeAuthorization(value: string): NostrEvent {
  const encoded = value.slice('Nostr '.length);
  return JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)),
    ),
  ) as NostrEvent;
}

afterEach(() => vi.unstubAllGlobals());

describe('relay media upload', () => {
  it('binds a signed BUD-11 authorization to the exact image bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    let request: { url: string; init?: RequestInit } | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        request = { url: String(input), init };
        const hash = (init?.headers as Record<string, string>)['X-SHA-256']!;
        return new Response(
          JSON.stringify({
            url: `https://relay.example/media/${hash}.jpg`,
            sha256: hash,
            size: bytes.byteLength,
            type: 'image/jpeg',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    const blob = await uploadMedia(http, bytes, 'image/jpeg');
    const headers = request!.init!.headers as Record<string, string>;
    const authorization = decodeAuthorization(headers.Authorization!);

    expect(request?.url).toBe('https://relay.example/upload');
    expect(request?.init?.method).toBe('PUT');
    expect(headers['Content-Type']).toBe('image/jpeg');
    expect(authorization.kind).toBe(24242);
    expect(authorization.pubkey).toBe(identity.publicKey);
    expect(authorization.tags).toContainEqual(['t', 'upload']);
    expect(authorization.tags).toContainEqual(['x', headers['X-SHA-256']]);
    expect(authorization.tags).toContainEqual(['server', 'relay.example']);
    expect(verifyEvent(authorization)).toBe(true);
    expect(new Uint8Array(request!.init!.body as ArrayBufferView).length).toBe(bytes.length);
    expect(blob.url).toContain(headers['X-SHA-256']!);
  });
});
