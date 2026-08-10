import { afterEach, describe, expect, it, vi } from 'vitest';
import { signEvent, verifyEvent, type NostrEvent } from '@beeline/nostr';
import { createIdentity } from './identity.js';
import { publishEvent, queryEvents, type HttpBridgeOptions } from './http.js';

const identity = createIdentity('http-test');
const opts: HttpBridgeOptions = {
  baseUrl: 'https://relay.example',
  host: 'relay.example',
  identity,
};

function authEvent(init?: RequestInit): NostrEvent {
  const headers = init?.headers as Record<string, string>;
  const encoded = headers.authorization.slice('Nostr '.length);
  const json = new TextDecoder().decode(
    Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)),
  );
  return JSON.parse(json) as NostrEvent;
}

function signedEvent(): NostrEvent {
  return signEvent(
    {
      pubkey: identity.publicKey,
      created_at: 1_700_000_000,
      kind: 1,
      tags: [],
      content: 'authenticated publish',
    },
    identity.secretKey,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HTTP bridge NIP-98 auth', () => {
  it('authenticates query and publish against their exact request URLs', async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ input: String(input), init });
        return new Response(
          String(input).endsWith('/query') ? '[]' : JSON.stringify({ accepted: true }),
          { status: 200 },
        );
      }),
    );

    await queryEvents(opts, [], identity.publicKey);
    await publishEvent(opts, signedEvent());

    expect(requests).toHaveLength(2);
    for (const [index, request] of requests.entries()) {
      const expectedUrl =
        index === 0 ? 'https://relay.example/query' : 'https://relay.example/events';
      const headers = request.init?.headers as Record<string, string>;
      const auth = authEvent(request.init);
      expect(request.input).toBe(expectedUrl);
      expect(request.init?.method).toBe('POST');
      expect(headers['x-pubkey']).toBe(identity.publicKey);
      expect(headers.host).toBe('relay.example');
      expect(auth.pubkey).toBe(identity.publicKey);
      expect(auth.tags).toContainEqual(['u', expectedUrl]);
      expect(auth.tags).toContainEqual(['method', 'POST']);
      expect(verifyEvent(auth)).toBe(true);
    }
  });

  it('keeps the X-Pubkey-only fallback when no signer identity is supplied', async () => {
    let headers: Record<string, string> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        headers = init?.headers as Record<string, string>;
        return new Response('[]', { status: 200 });
      }),
    );

    await queryEvents(
      { baseUrl: 'http://127.0.0.1:3010', host: '127.0.0.1:3010' },
      [],
      identity.publicKey,
    );

    expect(headers?.['x-pubkey']).toBe(identity.publicKey);
    expect(headers?.authorization).toBeUndefined();
  });
});
