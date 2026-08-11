import { afterEach, describe, expect, it, vi } from 'vitest';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import { listChannelsForPubkey, type ChannelOpsContext } from './channel.js';
import { createIdentity } from './identity.js';
import { KIND_CHANNEL_ADMINS, KIND_CHANNEL_MEMBERS } from './kinds.js';

const identity = createIdentity('channel-list-test');
const http = { baseUrl: 'http://relay.test', host: 'relay.test' };
const ctx: ChannelOpsContext = { http, identity };

function projection(kind: number, channelId: string): NostrEvent {
  return signEvent(
    {
      pubkey: identity.publicKey,
      created_at: 1_700_000_000,
      kind,
      tags: [['d', channelId], ['p', identity.publicKey]],
      content: '',
    },
    identity.secretKey,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('listChannelsForPubkey', () => {
  it('discovers both member and admin rooms without duplicates', async () => {
    let filter: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        filter = (JSON.parse(String(init?.body)) as Record<string, unknown>[])[0];
        return new Response(JSON.stringify([
          projection(KIND_CHANNEL_MEMBERS, 'member-room'),
          projection(KIND_CHANNEL_ADMINS, 'admin-room'),
          projection(KIND_CHANNEL_ADMINS, 'member-room'),
        ]), { status: 200 });
      }),
    );

    const channels = await listChannelsForPubkey(ctx, identity.publicKey);

    expect(filter?.kinds).toEqual([KIND_CHANNEL_MEMBERS, KIND_CHANNEL_ADMINS]);
    expect(filter?.['#p']).toEqual([identity.publicKey]);
    expect(channels.map(({ channelId }) => channelId)).toEqual(['member-room', 'admin-room']);
  });
});
