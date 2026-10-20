import { afterEach, describe, expect, it, vi } from 'vitest';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import { isMember, listMembers, type ChannelOpsContext } from './channel.js';
import { createIdentity } from './identity.js';
import { queryEvents } from './http.js';
import {
  KIND_CHANNEL_ADMINS,
  KIND_CHANNEL_MEMBERS,
  KIND_CREATE_GROUP,
  KIND_STREAM_MESSAGE,
} from './kinds.js';
import { tagValue } from './parse.js';

const identity = createIdentity('channel-list-test');
const memberIdentity = createIdentity('channel-member-test');
const http = { baseUrl: 'http://relay.test', host: 'relay.test', identity };
const ctx: ChannelOpsContext = { http, identity };

function projection(kind: number, channelId: string): NostrEvent {
  return signEvent(
    {
      pubkey: identity.publicKey,
      created_at: 1_700_000_000,
      kind,
      tags: [
        ['d', channelId],
        ['p', identity.publicKey],
      ],
      content: '',
    },
    identity.secretKey,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('listChannelsForPubkey', () => {
  it('counts current owner/admin projections as channel membership', async () => {
    const channelId = 'admin-room';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const filter = (JSON.parse(String(init?.body)) as Record<string, unknown>[])[0]!;
        const kind = (filter.kinds as number[])[0];
        if (kind === KIND_CHANNEL_ADMINS) {
          return new Response(
            JSON.stringify([
              signEvent(
                {
                  pubkey: identity.publicKey,
                  created_at: 1_700_000_001,
                  kind,
                  tags: [
                    ['d', channelId],
                    ['p', identity.publicKey, 'owner'],
                  ],
                  content: '',
                },
                identity.secretKey,
              ),
            ]),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify([]), { status: 200 });
      }),
    );

    await expect(listMembers(ctx, channelId)).resolves.toEqual([
      { pubkey: identity.publicKey, role: 'owner' },
    ]);
    await expect(isMember(ctx, channelId, identity.publicKey)).resolves.toBe(true);
  });
});
