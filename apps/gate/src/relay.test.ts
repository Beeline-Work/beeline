import { afterEach, describe, expect, it, vi } from 'vitest';
import { signEvent, verifyEvent, type NostrEvent } from '@beeline/nostr';
import { newIdentity } from './identity.js';
import { archiveChannel, KIND_CREATE_GROUP, KIND_EDIT_METADATA } from './buzz.js';
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

describe('archive writer boundary', () => {
  it('publishes kind:9002 only for an immutable child channel', async () => {
    const identity = newIdentity('corner-owner');
    const cornerId = 'corner';
    const create = signEvent(
      {
        pubkey: identity.publicKey,
        created_at: 1_700_000_000,
        kind: KIND_CREATE_GROUP,
        tags: [
          ['h', cornerId],
          ['parent', 'room'],
        ],
        content: '',
      },
      identity.secretKey,
    );
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/query')) {
          return new Response(JSON.stringify([create]), { status: 200 });
        }
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response('{"accepted":true}', { status: 200 });
      }),
    );

    await archiveChannel(identity, cornerId);

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ kind: KIND_EDIT_METADATA });
    expect(published[0]?.tags).toEqual(
      expect.arrayContaining([
        ['h', cornerId],
        ['archived', 'true'],
      ]),
    );
  });

  it('refuses a Workspace or top-level Room before kind:9002 is published', async () => {
    const identity = newIdentity('room-owner');
    const roomId = 'room';
    const create = signEvent(
      {
        pubkey: identity.publicKey,
        created_at: 1_700_000_000,
        kind: KIND_CREATE_GROUP,
        tags: [['h', roomId]],
        content: '',
      },
      identity.secretKey,
    );
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/query')) {
          return new Response(JSON.stringify([create]), { status: 200 });
        }
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response('{"accepted":true}', { status: 200 });
      }),
    );

    await expect(archiveChannel(identity, roomId)).rejects.toThrow(
      'refusing to archive non-corner channel room',
    );
    expect(published).toHaveLength(0);
  });
});
