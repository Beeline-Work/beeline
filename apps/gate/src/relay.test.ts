import { afterEach, describe, expect, it, vi } from 'vitest';
import { signEvent, verifyEvent, type NostrEvent } from '@beeline/nostr';
import { newIdentity } from './identity.js';
import { createRelayClient } from './relay.js';

afterEach(() => vi.unstubAllGlobals());

describe('authenticated relay client', () => {
  it('NIP-98-authenticates every read and write with its bound identity', async () => {
    const identity = newIdentity('daemon-agent');
    const client = createRelayClient(identity, {
      baseUrl: 'https://relay.test',
      host: 'relay.test',
    });
    const requests: Array<{ url: string; auth: NostrEvent }> = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const authorization = new Headers(init?.headers).get('authorization');
        if (!authorization?.startsWith('Nostr ')) {
          return new Response(JSON.stringify({ error: 'missing Nostr auth' }), { status: 401 });
        }
        const auth = JSON.parse(
          Buffer.from(authorization.slice('Nostr '.length), 'base64').toString('utf8'),
        ) as NostrEvent;
        requests.push({ url, auth });
        expect(verifyEvent(auth)).toBe(true);
        expect(auth.pubkey).toBe(identity.publicKey);
        expect(auth.tags).toContainEqual(['u', url]);
        expect(auth.tags).toContainEqual(['method', 'POST']);
        return new Response(url.endsWith('/query') ? '[]' : '{"accepted":true}', {
          status: 200,
        });
      }),
    );

    await client.queryEvents([{ kinds: [39002] }]);
    await client.publishEvent(
      signEvent(
        {
          pubkey: identity.publicKey,
          created_at: 1_700_000_000,
          kind: 9000,
          tags: [['h', 'room'], ['p', identity.publicKey], ['role', 'member']],
          content: '',
        },
        identity.secretKey,
      ),
    );

    expect(requests.map(({ url }) => url)).toEqual([
      'https://relay.test/query',
      'https://relay.test/events',
    ]);
  });

  it('refuses to authenticate a publish for a different event signer', async () => {
    const identity = newIdentity('daemon-agent');
    const other = newIdentity('other');
    const client = createRelayClient(identity);
    const event = signEvent(
      { pubkey: other.publicKey, created_at: 1, kind: 9, tags: [], content: '' },
      other.secretKey,
    );

    await expect(client.publishEvent(event)).rejects.toThrow('must match');
  });
});
