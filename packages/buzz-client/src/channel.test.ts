import { afterEach, describe, expect, it, vi } from 'vitest';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import {
  archiveRoom,
  createChannel,
  isMember,
  getChannelMetadata,
  leaveRoom,
  listChannelsForPubkey,
  listMembers,
  listSubchannels,
  renameChannel,
  setChannelVisibility,
  waitUntilMember,
  type ChannelOpsContext,
} from './channel.js';
import { createIdentity } from './identity.js';
import {
  KIND_CHANNEL_ADMINS,
  KIND_CHANNEL_MEMBERS,
  KIND_CHANNEL_METADATA,
  KIND_CREATE_GROUP,
  KIND_EDIT_METADATA,
  KIND_STREAM_MESSAGE,
  TAG_ROOM_LIFECYCLE,
} from './kinds.js';
import { tagValue } from './parse.js';
import type { RelayWs } from './ws.js';

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

describe('listSubchannels', () => {
  it('keeps an invite-only corner discoverable through its parent control link', async () => {
    const parentChannelId = 'parent-room';
    const closedCornerId = 'closed-corner';
    const control = signEvent(
      {
        pubkey: identity.publicKey,
        created_at: 1_700_000_000,
        kind: KIND_STREAM_MESSAGE,
        tags: [
          ['h', parentChannelId],
          ['t', 'body-control'],
          ['subchannel', closedCornerId],
          ['status', 'working'],
        ],
        content: 'Agent is working.',
      },
      identity.secretKey,
    );
    const filterRequests: Record<string, unknown>[][] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        filterRequests.push(JSON.parse(String(init?.body)) as Record<string, unknown>[]);
        // The kind:9007 create can be omitted by a closed NIP-29 child query;
        // its parent-scoped control link must still surface the corner.
        return new Response(JSON.stringify([control]), { status: 200 });
      }),
    );

    await expect(listSubchannels(ctx, parentChannelId)).resolves.toEqual([closedCornerId]);
    expect(filterRequests.flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kinds: [KIND_CREATE_GROUP] }),
        expect.objectContaining({
          kinds: [KIND_STREAM_MESSAGE],
          '#h': [parentChannelId],
          '#t': ['body-control'],
        }),
      ]),
    );
  });

  it('pages past a full newest-N window instead of forgetting older corners', async () => {
    // A Nostr `limit` returns the NEWEST N matches, and the kind:9007 scan is
    // relay-wide because `parent` is a multi-character tag and so cannot be
    // filtered on. This repository has now found the same bug three times in
    // three places: an older corner simply falls out of the window and becomes
    // invisible to everything that reads this list.
    const parentChannelId = 'parent-room';
    const roomCreatedAt = 1_700_000_000;
    const create = (id: string, createdAt: number): NostrEvent =>
      signEvent(
        {
          pubkey: identity.publicKey,
          created_at: createdAt,
          kind: KIND_CREATE_GROUP,
          tags: [
            ['h', id],
            ['parent', parentChannelId],
          ],
          content: '',
        },
        identity.secretKey,
      );
    // A relay whose newest page is entirely other people's channels, with this
    // Room's own corner one page further back.
    const noise = Array.from({ length: 3 }, (_unused, index) =>
      signEvent(
        {
          pubkey: identity.publicKey,
          created_at: roomCreatedAt + 500 + index,
          kind: KIND_CREATE_GROUP,
          tags: [
            ['h', `someone-elses-${index}`],
            ['parent', 'another-room'],
          ],
          content: '',
        },
        identity.secretKey,
      ),
    );
    const oldCorner = create('old-corner', roomCreatedAt + 10);
    const roomCreate = signEvent(
      {
        pubkey: identity.publicKey,
        created_at: roomCreatedAt,
        kind: KIND_CREATE_GROUP,
        tags: [['h', parentChannelId]],
        content: '',
      },
      identity.secretKey,
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const filter = (JSON.parse(String(init?.body)) as Record<string, unknown>[])[0] ?? {};
        if ((filter.kinds as number[])[0] !== KIND_CREATE_GROUP) {
          return new Response(JSON.stringify([]), { status: 200 });
        }
        const scoped = (filter['#h'] as string[] | undefined)?.[0];
        if (scoped === parentChannelId) {
          return new Response(JSON.stringify([roomCreate]), { status: 200 });
        }
        const until = filter.until as number | undefined;
        const limit = filter.limit as number;
        const all = [...noise, oldCorner, roomCreate].sort((a, b) => b.created_at - a.created_at);
        const page = all
          .filter((event) => until === undefined || event.created_at <= until)
          .slice(0, limit);
        return new Response(JSON.stringify(page), { status: 200 });
      }),
    );

    // A window of 3 cannot see `old-corner` in one read; paging back to the
    // Room's own creation finds it. No child of a Room predates the Room, so
    // that is the honest place to stop.
    await expect(listSubchannels(ctx, parentChannelId, 3)).resolves.toEqual(['old-corner']);
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

describe('getChannelMetadata', () => {
  it('chooses the newest metadata projection when relay query order is stale-first', async () => {
    const channelId = 'metadata-order-room';
    const metadata = (name: string, createdAt: number) =>
      signEvent(
        {
          pubkey: identity.publicKey,
          created_at: createdAt,
          kind: KIND_CHANNEL_METADATA,
          tags: [['d', channelId], ['name', name]],
          content: '',
        },
        identity.secretKey,
      );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify([metadata('Old name', 1_700_000_000), metadata('New name', 1_700_000_001)])),
      ),
    );

    await expect(getChannelMetadata(ctx, channelId)).resolves.toMatchObject({ name: 'New name' });
  });
});

describe('setChannelVisibility', () => {
  it('publishes and verifies invite-only Room metadata for an owner', async () => {
    const channelId = 'visibility-room';
    let projectedVisibility = 'open';
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          const event = JSON.parse(String(init?.body)) as NostrEvent;
          published.push(event);
          projectedVisibility = tagValue(event, 'visibility') ?? projectedVisibility;
          return new Response(JSON.stringify({ accepted: true }), { status: 200 });
        }
        const filter = (JSON.parse(String(init?.body)) as Record<string, unknown>[])[0]!;
        const kind = (filter.kinds as number[])[0];
        if (kind === KIND_CREATE_GROUP) {
          return new Response(
            JSON.stringify([
              signEvent(
                {
                  pubkey: identity.publicKey,
                  created_at: 1_700_000_000,
                  kind,
                  tags: [
                    ['h', channelId],
                    ['name', 'Visibility room'],
                  ],
                  content: '',
                },
                identity.secretKey,
              ),
            ]),
          );
        }
        if (kind === KIND_CHANNEL_MEMBERS) {
          return new Response(JSON.stringify([projection(kind, channelId)]));
        }
        if (kind === KIND_CHANNEL_ADMINS) {
          return new Response(
            JSON.stringify([
              signEvent(
                {
                  pubkey: identity.publicKey,
                  created_at: 1_700_000_000,
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
          );
        }
        if (kind === KIND_CHANNEL_METADATA) {
          return new Response(
            JSON.stringify([
              signEvent(
                {
                  pubkey: identity.publicKey,
                  created_at: 1_700_000_001,
                  kind,
                  tags: [
                    ['d', channelId],
                    ['name', 'Visibility room'],
                    ...(projectedVisibility === 'private' ? [['private'], ['closed']] : []),
                  ],
                  content: '',
                },
                identity.secretKey,
              ),
            ]),
          );
        }
        return new Response(JSON.stringify([]));
      }),
    );

    await expect(setChannelVisibility(ctx, channelId, 'invite-only')).resolves.toMatchObject({
      visibility: 'invite-only',
    });
    expect(published[0]!.tags).toContainEqual(['visibility', 'private']);
  });
});

describe('waitUntilMember (WS-driven)', () => {
  function membersResponse(channelId: string, pubkey: string): Response {
    return new Response(
      JSON.stringify([
        signEvent(
          {
            pubkey: identity.publicKey,
            created_at: 1_700_000_000,
            kind: KIND_CHANNEL_MEMBERS,
            tags: [['d', channelId], ['p', pubkey]],
            content: '',
          },
          identity.secretKey,
        ),
      ]),
    );
  }

  it('resolves off a live WS push without waiting on the backstop poll', async () => {
    const channelId = 'ws-member-room';
    const recruit = createIdentity('ws-recruit');
    let recruitIsMember = false;
    let memberQueryCount = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const filter = (JSON.parse(String(init?.body)) as Record<string, unknown>[])[0]!;
        const kind = (filter.kinds as number[])[0];
        if (kind !== KIND_CHANNEL_MEMBERS) return new Response(JSON.stringify([]));
        memberQueryCount += 1;
        return recruitIsMember
          ? membersResponse(channelId, recruit.publicKey)
          : new Response(JSON.stringify([]));
      }),
    );

    let capturedHandler: (() => void) | undefined;
    const unsubscribe = vi.fn();
    const fakeSocket = {
      connected: true,
      subscribe: vi.fn((_filters: unknown, onEvent: () => void) => {
        capturedHandler = onEvent;
        return unsubscribe;
      }),
    };
    const wsCtx: ChannelOpsContext = {
      http,
      identity,
      ws: () => fakeSocket as unknown as RelayWs,
    };

    const waitPromise = waitUntilMember(wsCtx, channelId, recruit.publicKey, {
      timeoutMs: 15_000,
    });

    await vi.waitFor(() => expect(memberQueryCount).toBeGreaterThan(0));
    expect(fakeSocket.subscribe).toHaveBeenCalledOnce();
    expect(capturedHandler).toBeDefined();

    recruitIsMember = true;
    capturedHandler!();

    await expect(waitPromise).resolves.toBeUndefined();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('falls back to plain interval polling when a live socket exists but is not connected', async () => {
    const channelId = 'disconnected-room';
    const recruit = createIdentity('disconnected-recruit');
    let attempt = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const filter = (JSON.parse(String(init?.body)) as Record<string, unknown>[])[0]!;
        const kind = (filter.kinds as number[])[0];
        if (kind !== KIND_CHANNEL_MEMBERS) return new Response(JSON.stringify([]));
        attempt += 1;
        return attempt < 2 ? new Response(JSON.stringify([])) : membersResponse(channelId, recruit.publicKey);
      }),
    );

    const disconnectedSocket = { connected: false, subscribe: vi.fn() };
    const wsCtx: ChannelOpsContext = {
      http,
      identity,
      ws: () => disconnectedSocket as unknown as RelayWs,
    };

    await expect(
      waitUntilMember(wsCtx, channelId, recruit.publicKey, { timeoutMs: 2_000, intervalMs: 20 }),
    ).resolves.toBeUndefined();
    expect(disconnectedSocket.subscribe).not.toHaveBeenCalled();
    expect(attempt).toBeGreaterThanOrEqual(2);
  });

  it('throws after the timeout when neither a WS push nor the backstop poll ever finds membership', async () => {
    const channelId = 'timeout-room';
    const recruit = createIdentity('timeout-recruit');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([]))));

    const fakeSocket = {
      connected: true,
      subscribe: vi.fn(() => vi.fn()),
    };
    const wsCtx: ChannelOpsContext = {
      http,
      identity,
      ws: () => fakeSocket as unknown as RelayWs,
    };

    await expect(
      waitUntilMember(wsCtx, channelId, recruit.publicKey, { timeoutMs: 80, intervalMs: 20 }),
    ).rejects.toThrow(/membership not visible/);
  });
});

describe('top-level Room creation is human-only', () => {
  const agent = createIdentity('agent-creator');
  const human = createIdentity('human-creator');

  /** The durable self-signed first-class agent record (`#t=buzz-agent`). */
  function agentRecord(): NostrEvent {
    return signEvent(
      {
        pubkey: agent.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        kind: KIND_STREAM_MESSAGE,
        tags: [['t', 'buzz-agent']],
        content: '',
      },
      agent.secretKey,
    );
  }

  function stubRelay(): NostrEvent[] {
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/events')) {
          published.push(JSON.parse(String(init?.body)) as NostrEvent);
          return new Response(JSON.stringify({ accepted: true }), { status: 200 });
        }
        const filter = (JSON.parse(String(init?.body)) as Record<string, unknown>[])[0] ?? {};
        if ((filter.kinds as number[] | undefined)?.[0] === KIND_STREAM_MESSAGE) {
          const authors = (filter.authors as string[]) ?? [];
          return new Response(
            JSON.stringify(authors.includes(agent.publicKey) ? [agentRecord()] : []),
            { status: 200 },
          );
        }
        return new Response('[]', { status: 200 });
      }),
    );
    return published;
  }

  it('refuses a registered agent identity as the creator of a Room', async () => {
    const published = stubRelay();

    await expect(createChannel({ http: { ...http, identity: agent }, identity: agent }, 'firstmate'))
      .rejects.toThrow('room creation is a human action');
    // The refusal happens before any kind:9007 write leaves the client.
    expect(published).toEqual([]);
  });

  it('still creates a Room when the creator has no agent record (human)', async () => {
    const published = stubRelay();
    const humanCtx: ChannelOpsContext = { http: { ...http, identity: human }, identity: human };

    const channelId = await createChannel(humanCtx, 'beeline');
    expect(channelId).toBeTruthy();
    expect(published).toHaveLength(1);
    expect(published[0]!.kind).toBe(KIND_CREATE_GROUP);
    expect(published[0]!.pubkey).toBe(human.publicKey);
  });

  it('never consults the agent registry for a corner (child channel)', async () => {
    const published = stubRelay();
    let registryQueries = 0;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/events')) {
        published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return new Response(JSON.stringify({ accepted: true }), { status: 200 });
      }
      registryQueries += 1;
      return new Response('[]', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const channelId = await createChannel(
      { http: { ...http, identity: agent }, identity: agent },
      'fix-the-thing',
      { parentChannelId: 'parent-room' },
    );
    expect(channelId).toBeTruthy();
    expect(registryQueries).toBe(0);
    expect(published[0]!.tags).toContainEqual(['parent', 'parent-room']);
  });
});

describe('archiveRoom and leaveRoom against an already-archived channel', () => {
  const archivedError = JSON.stringify({ error: 'invalid: channel is archived' });

  function stubRelay(
    channelId: string,
    opts: { role?: 'owner' | 'member'; publish: (event: NostrEvent) => Response },
  ): NostrEvent[] {
    const published: NostrEvent[] = [];
    const role = opts.role ?? 'owner';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          const event = JSON.parse(String(init?.body)) as NostrEvent;
          published.push(event);
          return opts.publish(event);
        }
        const filter = (JSON.parse(String(init?.body)) as Record<string, unknown>[])[0]!;
        const kind = (filter.kinds as number[])[0]!;
        if (kind === KIND_CREATE_GROUP) {
          return new Response(
            JSON.stringify([
              signEvent(
                {
                  pubkey: identity.publicKey,
                  created_at: 1_700_000_000,
                  kind,
                  tags: [['h', channelId]],
                  content: '',
                },
                identity.secretKey,
              ),
            ]),
          );
        }
        if (kind === KIND_CHANNEL_MEMBERS || kind === KIND_CHANNEL_ADMINS) {
          if (kind === KIND_CHANNEL_ADMINS && opts.role === 'member') {
            return new Response('[]');
          }
          const pTag =
            kind === KIND_CHANNEL_ADMINS
              ? ['p', identity.publicKey, role]
              : ['p', identity.publicKey];
          return new Response(
            JSON.stringify([
              signEvent(
                {
                  pubkey: identity.publicKey,
                  created_at: 1_700_000_000,
                  kind,
                  tags: [['d', channelId], pTag],
                  content: '',
                },
                identity.secretKey,
              ),
            ]),
          );
        }
        if (kind === KIND_CHANNEL_METADATA) {
          return new Response(
            JSON.stringify([
              signEvent(
                {
                  pubkey: identity.publicKey,
                  created_at: 1_700_000_001,
                  kind,
                  tags: [['d', channelId], ['archived', 'true']],
                  content: '',
                },
                identity.secretKey,
              ),
            ]),
          );
        }
        return new Response('[]');
      }),
    );
    return published;
  }

  it('resolves success when the relay refuses the delete because the channel is already archived', async () => {
    let attempts = 0;
    const published = stubRelay('already-archived-room', {
      publish: () => {
        attempts += 1;
        return new Response(archivedError, { status: 400 });
      },
    });

    await expect(archiveRoom(ctx, 'already-archived-room')).resolves.toBeUndefined();

    // A 400 is fail-fast (never retried) and the classifier matched, so the
    // desired terminal state was already reached — no error surfaced.
    expect(attempts).toBe(1);
    expect(published[0]!.kind).toBe(KIND_EDIT_METADATA);
    expect(published[0]!.tags).toContainEqual(['archived', 'true']);
  });

  it('archives a live channel through the unchanged publish + projection path', async () => {
    const published = stubRelay('live-room', {
      publish: () => new Response(JSON.stringify({ accepted: true }), { status: 200 }),
    });

    await expect(archiveRoom(ctx, 'live-room')).resolves.toBeUndefined();
    expect(published).toHaveLength(1);
    expect(published[0]!.tags).toContainEqual(['t', TAG_ROOM_LIFECYCLE]);
    expect(published[0]!.tags).toContainEqual(['action', 'admin-delete']);
  });

  it('still surfaces a genuine publish failure on delete', async () => {
    stubRelay('broken-room', {
      publish: () => new Response(JSON.stringify({ error: 'invalid: bad signature' }), { status: 400 }),
    });

    await expect(archiveRoom(ctx, 'broken-room')).rejects.toThrow(/bad signature/);
  });

  it('lets a member leave an already-archived Room without a successful publish', async () => {
    let attempts = 0;
    stubRelay('leave-archived-room', {
      role: 'member',
      publish: () => {
        attempts += 1;
        return new Response(archivedError, { status: 400 });
      },
    });

    await expect(leaveRoom(ctx, 'leave-archived-room')).resolves.toBeUndefined();
    expect(attempts).toBe(1);
  });

  it('still surfaces a genuine failure when leaving a live Room', async () => {
    stubRelay('leave-live-room', {
      role: 'member',
      publish: () => new Response(JSON.stringify({ error: 'invalid: not permitted' }), { status: 400 }),
    });

    await expect(leaveRoom(ctx, 'leave-live-room')).rejects.toThrow(/not permitted/);
  });
});
