import { afterEach, describe, expect, it, vi } from 'vitest';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import {
  isMember,
  listChannelsForPubkey,
  listMembers,
  renameChannel,
  type ChannelOpsContext,
} from './channel.js';
import { createIdentity } from './identity.js';
import {
  KIND_CHANNEL_ADMINS,
  KIND_CHANNEL_MEMBERS,
  KIND_CHANNEL_METADATA,
  KIND_CREATE_GROUP,
  KIND_EDIT_METADATA,
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
                  tags: [['d', channelId], ['p', identity.publicKey, 'owner']],
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

describe('renameChannel', () => {
  it('publishes owner-authored metadata, preserves existing fields, and verifies projection', async () => {
    const channelId = 'rename-room';
    const published: NostrEvent[] = [];
    let projectedName = 'Old name';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          const event = JSON.parse(String(init?.body)) as NostrEvent;
          published.push(event);
          projectedName = tagValue(event, 'name') ?? projectedName;
          return new Response(JSON.stringify({ accepted: true }), { status: 200 });
        }
        const filter = (JSON.parse(String(init?.body)) as Record<string, unknown>[])[0]!;
        const kind = (filter.kinds as number[])[0];
        if (kind === KIND_CREATE_GROUP) {
          return new Response(JSON.stringify([
            signEvent(
              {
                pubkey: identity.publicKey,
                created_at: 1_700_000_000,
                kind,
                tags: [['h', channelId], ['name', 'Old name']],
                content: '',
              },
              identity.secretKey,
            ),
          ]));
        }
        if (kind === KIND_CHANNEL_MEMBERS) {
          return new Response(JSON.stringify([projection(kind, channelId)]));
        }
        if (kind === KIND_CHANNEL_ADMINS) {
          return new Response(JSON.stringify([
            signEvent(
              {
                pubkey: identity.publicKey,
                created_at: 1_700_000_000,
                kind,
                tags: [['d', channelId], ['p', identity.publicKey, 'owner']],
                content: '',
              },
              identity.secretKey,
            ),
          ]));
        }
        if (kind === KIND_CHANNEL_METADATA) {
          return new Response(JSON.stringify([
            signEvent(
              {
                pubkey: identity.publicKey,
                created_at: 1_700_000_001,
                kind,
                tags: [
                  ['d', channelId],
                  ['name', projectedName],
                  ['about', 'Keep this'],
                  ['archived', 'true'],
                ],
                content: '',
              },
              identity.secretKey,
            ),
          ]));
        }
        return new Response(JSON.stringify([]));
      }),
    );

    await expect(renameChannel(ctx, channelId, '  New name  ')).resolves.toMatchObject({
      channelId,
      name: 'New name',
      about: 'Keep this',
      archived: true,
    });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ kind: KIND_EDIT_METADATA, pubkey: identity.publicKey });
    expect(published[0]!.tags).toEqual(
      expect.arrayContaining([
        ['h', channelId],
        ['name', 'New name'],
        ['about', 'Keep this'],
        ['archived', 'true'],
      ]),
    );
  });

  it('rejects empty names before publishing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(renameChannel(ctx, 'rename-room', '   ')).rejects.toThrow(
      'Room name cannot be empty',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a normal member before publishing metadata', async () => {
    const channelId = 'member-room';
    const memberCtx: ChannelOpsContext = {
      identity: memberIdentity,
      http: { baseUrl: 'http://relay.test', host: 'relay.test', identity: memberIdentity },
    };
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          published.push(JSON.parse(String(init?.body)) as NostrEvent);
          return new Response(JSON.stringify({ accepted: true }), { status: 200 });
        }
        const filter = (JSON.parse(String(init?.body)) as Record<string, unknown>[])[0]!;
        const kind = (filter.kinds as number[])[0];
        if (kind === KIND_CREATE_GROUP) {
          return new Response(JSON.stringify([
            signEvent(
              {
                pubkey: identity.publicKey,
                created_at: 1_700_000_000,
                kind,
                tags: [['h', channelId], ['name', 'Old name']],
                content: '',
              },
              identity.secretKey,
            ),
          ]));
        }
        if (kind === KIND_CHANNEL_MEMBERS) {
          return new Response(JSON.stringify([
            signEvent(
              {
                pubkey: identity.publicKey,
                created_at: 1_700_000_000,
                kind,
                tags: [
                  ['d', channelId],
                  ['p', identity.publicKey],
                  ['p', memberIdentity.publicKey],
                ],
                content: '',
              },
              identity.secretKey,
            ),
          ]));
        }
        if (kind === KIND_CHANNEL_ADMINS) {
          return new Response(JSON.stringify([
            signEvent(
              {
                pubkey: identity.publicKey,
                created_at: 1_700_000_000,
                kind,
                tags: [['d', channelId], ['p', identity.publicKey, 'owner']],
                content: '',
              },
              identity.secretKey,
            ),
          ]));
        }
        return new Response(JSON.stringify([]));
      }),
    );

    await expect(renameChannel(memberCtx, channelId, 'Nope')).rejects.toThrow(
      'only a Room owner or admin can rename it',
    );
    expect(published).toHaveLength(0);
  });
});
