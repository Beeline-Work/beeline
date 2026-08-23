import { afterEach, describe, expect, it, vi } from 'vitest';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import { createChannel, type ChannelOpsContext } from './channel.js';
import {
  attachCommunityMemberToChannel,
  communityMembers,
  createCommunity,
  createInvite,
  DEFAULT_INVITE_TTL_SECONDS,
  findCommunityInvite,
  getCommunity,
  inviteTokenHash,
  leaveCommunity,
  listCommunityInvites,
  listCommunities,
  parseCommunityInvite,
  repairCommunityRoomMemberships,
  redeemInvite,
  renameCommunity,
  revokeCommunityInvite,
  setCommunityAvatar,
  setCommunityVisibility,
} from './community.js';
import { createIdentity } from './identity.js';
import {
  KIND_CHANNEL_ADMINS,
  KIND_CHANNEL_METADATA,
  KIND_CHANNEL_MEMBERS,
  KIND_COMMUNITY_INVITE,
  KIND_CREATE_GROUP,
  KIND_EDIT_METADATA,
  KIND_PUT_USER,
  KIND_REMOVE_USER,
  KIND_STREAM_MESSAGE,
  TAG_AGENT,
  TAG_COMMUNITY,
  TAG_COMMUNITY_INVITE,
} from './kinds.js';
import { tagValue, tagValues } from './parse.js';

const communityId = '11111111-1111-4111-8111-111111111111';
const channelId = '22222222-2222-4222-8222-222222222222';
const owner = createIdentity('owner');
const admin = createIdentity('admin');
const invitee = createIdentity('invitee');
const outsider = createIdentity('outsider');
const http = { baseUrl: 'http://relay.test', host: 'relay.test' };

function ctx(identity = owner): ChannelOpsContext {
  return { http: { ...http, identity }, identity };
}

function signed(
  identity: typeof owner,
  kind: number,
  tags: string[][],
  createdAt = 1_700_000_000,
): NostrEvent {
  return signEvent(
    { pubkey: identity.publicKey, created_at: createdAt, kind, tags, content: '' },
    identity.secretKey,
  );
}

function communityCreate(): NostrEvent {
  return signed(owner, KIND_CREATE_GROUP, [
    ['h', communityId],
    ['name', 'Builders'],
    ['avatar', 'https://example.test/builders.png'],
    ['channel_type', 'stream'],
    ['visibility', 'open'],
    [TAG_COMMUNITY, communityId],
  ]);
}

function memberState(includeInvitee = false): NostrEvent {
  return signed(owner, KIND_CHANNEL_MEMBERS, [
    ['d', communityId],
    ['p', owner.publicKey],
    ...(includeInvitee ? [['p', invitee.publicKey]] : []),
  ]);
}

function adminState(): NostrEvent {
  return signed(owner, KIND_CHANNEL_ADMINS, [
    ['d', communityId],
    ['p', owner.publicKey, 'owner'],
  ]);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function filterFrom(init?: RequestInit): Record<string, unknown> {
  const body = JSON.parse(String(init?.body)) as Record<string, unknown>[];
  return body[0] ?? {};
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('community model', () => {
  it('places an existing Workspace person in a Room as a member and asserts projection', async () => {
    const published: NostrEvent[] = [];
    let joined = false;
    const channelCreate = signed(owner, KIND_CREATE_GROUP, [
      ['h', channelId],
      ['name', 'general'],
      [TAG_COMMUNITY, communityId],
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          const event = JSON.parse(String(init?.body)) as NostrEvent;
          published.push(event);
          if (event.kind === KIND_PUT_USER && tagValue(event, 'h') === channelId) joined = true;
          return jsonResponse({ accepted: true });
        }
        const filter = filterFrom(init);
        const kind = (filter.kinds as number[])[0];
        const requestedId = ((filter['#h'] ?? filter['#d']) as string[] | undefined)?.[0];
        if (kind === KIND_CREATE_GROUP) {
          if (requestedId === channelId) return jsonResponse([channelCreate]);
          if (requestedId === communityId) return jsonResponse([communityCreate()]);
        }
        if (kind === KIND_CHANNEL_ADMINS) {
          return requestedId === communityId ? jsonResponse([adminState()]) : jsonResponse([]);
        }
        if (kind === KIND_CHANNEL_MEMBERS) {
          if (requestedId === communityId) return jsonResponse([memberState(true)]);
          if (requestedId === channelId) {
            return jsonResponse([
              signed(owner, KIND_CHANNEL_MEMBERS, [
                ['d', channelId],
                ['p', owner.publicKey],
                ...(joined ? [['p', invitee.publicKey]] : []),
              ]),
            ]);
          }
        }
        return jsonResponse([]);
      }),
    );

    await expect(
      attachCommunityMemberToChannel(ctx(), channelId, invitee.publicKey, communityId),
    ).resolves.toMatchObject({ joined: true });
    expect(published).toHaveLength(1);
    expect(tagValue(published[0]!, 'p')).toBe(invitee.publicKey);
    expect(tagValue(published[0]!, 'role')).toBe('member');
    expect(tagValue(published[0]!, TAG_COMMUNITY)).toBe(communityId);
  });

  it('creates a self-linked NIP-29 community and an optionally-linked channel', async () => {
    const published: NostrEvent[] = [];
    let channelCreated = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          const event = JSON.parse(String(init?.body)) as NostrEvent;
          published.push(event);
          if (event.kind === KIND_CREATE_GROUP && tagValue(event, 'h') === channelId) {
            channelCreated = true;
          }
          return jsonResponse({ accepted: true });
        }
        const filter = filterFrom(init);
        if ((filter.kinds as number[])[0] === KIND_CHANNEL_MEMBERS) {
          const requestedId = (filter['#d'] as string[] | undefined)?.[0];
          if (requestedId === channelId && channelCreated) {
            return jsonResponse([
              signed(owner, KIND_CHANNEL_MEMBERS, [
                ['d', channelId],
                ['p', owner.publicKey],
              ]),
            ]);
          }
          if (requestedId === communityId) return jsonResponse([memberState()]);
        }
        return jsonResponse([]);
      }),
    );

    expect(await createCommunity(ctx(), ' Builders ', { communityId })).toBe(communityId);
    expect(await createChannel(ctx(), 'general', { channelId, communityId })).toBe(channelId);

    expect(published[0]?.kind).toBe(KIND_CREATE_GROUP);
    expect(tagValue(published[0]!, 'channel_type')).toBe('stream');
    expect(tagValue(published[0]!, TAG_COMMUNITY)).toBe(communityId);
    expect(tagValue(published[0]!, 'name')).toBe('Builders');
    expect(published[0]?.pubkey).toBe(owner.publicKey);

    expect(published[1]?.kind).toBe(KIND_CREATE_GROUP);
    expect(tagValue(published[1]!, TAG_COMMUNITY)).toBe(communityId);
    expect(tagValue(published[1]!, 'channel_type')).toBe('stream');
  });

  it('lets an owner publish and verify a Workspace picture metadata projection', async () => {
    const create = communityCreate();
    const published: NostrEvent[] = [];
    let projectedAvatar: string | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          const event = JSON.parse(String(init?.body)) as NostrEvent;
          published.push(event);
          projectedAvatar = tagValue(event, 'avatar');
          return jsonResponse({ accepted: true });
        }
        const kind = (filterFrom(init).kinds as number[])[0];
        if (kind === KIND_CREATE_GROUP) return jsonResponse([create]);
        if (kind === KIND_CHANNEL_MEMBERS) return jsonResponse([memberState()]);
        if (kind === KIND_CHANNEL_ADMINS) return jsonResponse([adminState()]);
        if (kind === KIND_CHANNEL_METADATA) {
          return jsonResponse([
            signed(owner, KIND_CHANNEL_METADATA, [
              ['d', communityId],
              ['name', 'Builders'],
              ...(projectedAvatar ? [['purpose', `buzz-workspace-avatar:${projectedAvatar}`]] : []),
            ]),
          ]);
        }
        return jsonResponse([]);
      }),
    );

    const updated = await setCommunityAvatar(
      ctx(),
      communityId,
      ' https://media.example.test/workspace.png ',
    );

    expect(updated).toMatchObject({
      communityId,
      ownerPubkey: owner.publicKey,
      avatar: 'https://media.example.test/workspace.png',
    });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ kind: KIND_EDIT_METADATA, pubkey: owner.publicKey });
    expect(published[0]!.tags).toEqual(
      expect.arrayContaining([
        ['h', communityId],
        ['name', 'Builders'],
        ['avatar', 'https://media.example.test/workspace.png'],
        ['picture', 'https://media.example.test/workspace.png'],
        ['purpose', 'buzz-workspace-avatar:https://media.example.test/workspace.png'],
        [TAG_COMMUNITY, communityId],
      ]),
    );
  });

  it('can clear a picture inherited from the immutable Workspace create event', async () => {
    const create = communityCreate();
    let projectedMetadata: NostrEvent | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          const event = JSON.parse(String(init?.body)) as NostrEvent;
          projectedMetadata = signed(owner, KIND_CHANNEL_METADATA, [
            ['d', communityId],
            ['name', 'Builders'],
            ...event.tags.filter((tag) => ['avatar', 'picture', 'purpose'].includes(tag[0]!)),
          ]);
          return jsonResponse({ accepted: true });
        }
        const kind = (filterFrom(init).kinds as number[])[0];
        if (kind === KIND_CREATE_GROUP) return jsonResponse([create]);
        if (kind === KIND_CHANNEL_MEMBERS) return jsonResponse([memberState()]);
        if (kind === KIND_CHANNEL_ADMINS) return jsonResponse([adminState()]);
        if (kind === KIND_CHANNEL_METADATA) {
          return jsonResponse(projectedMetadata ? [projectedMetadata] : []);
        }
        return jsonResponse([]);
      }),
    );

    const updated = await setCommunityAvatar(ctx(), communityId, '');
    expect(updated.communityId).toBe(communityId);
    expect(updated.avatar).toBeUndefined();
    expect(projectedMetadata?.tags).toEqual(
      expect.arrayContaining([
        ['avatar', ''],
        ['picture', ''],
        ['purpose', 'buzz-workspace-avatar:'],
      ]),
    );
  });

  it('allows current admins to update a Workspace picture and rejects ordinary members', async () => {
    const create = communityCreate();
    const members = signed(owner, KIND_CHANNEL_MEMBERS, [
      ['d', communityId],
      ['p', owner.publicKey],
      ['p', admin.publicKey],
      ['p', invitee.publicKey],
    ]);
    const admins = signed(owner, KIND_CHANNEL_ADMINS, [
      ['d', communityId],
      ['p', owner.publicKey, 'owner'],
      ['p', admin.publicKey, 'admin'],
    ]);
    const published: NostrEvent[] = [];
    let projectedAvatar: string | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          const event = JSON.parse(String(init?.body)) as NostrEvent;
          published.push(event);
          projectedAvatar = tagValue(event, 'avatar');
          return jsonResponse({ accepted: true });
        }
        const kind = (filterFrom(init).kinds as number[])[0];
        if (kind === KIND_CREATE_GROUP) return jsonResponse([create]);
        if (kind === KIND_CHANNEL_MEMBERS) return jsonResponse([members]);
        if (kind === KIND_CHANNEL_ADMINS) return jsonResponse([admins]);
        if (kind === KIND_CHANNEL_METADATA) {
          return jsonResponse([
            signed(owner, KIND_CHANNEL_METADATA, [
              ['d', communityId],
              ['name', 'Builders'],
              ...(projectedAvatar ? [['purpose', `buzz-workspace-avatar:${projectedAvatar}`]] : []),
            ]),
          ]);
        }
        return jsonResponse([]);
      }),
    );

    await expect(
      setCommunityAvatar(ctx(admin), communityId, 'https://media.example.test/admin.png'),
    ).resolves.toMatchObject({ avatar: 'https://media.example.test/admin.png' });
    await expect(
      setCommunityAvatar(ctx(invitee), communityId, 'https://media.example.test/member.png'),
    ).rejects.toThrow('only a Workspace owner or admin');
    expect(published).toHaveLength(1);
    expect(published[0]!.pubkey).toBe(admin.publicKey);
  });

  it('renames a Workspace and changes its visibility through admin metadata', async () => {
    const create = communityCreate();
    let projectedName = 'Builders';
    let projectedVisibility = 'open';
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          const event = JSON.parse(String(init?.body)) as NostrEvent;
          published.push(event);
          projectedName = tagValue(event, 'name') ?? projectedName;
          projectedVisibility = tagValue(event, 'visibility') ?? projectedVisibility;
          return jsonResponse({ accepted: true });
        }
        const kind = (filterFrom(init).kinds as number[])[0];
        if (kind === KIND_CREATE_GROUP) return jsonResponse([create]);
        if (kind === KIND_CHANNEL_MEMBERS) return jsonResponse([memberState()]);
        if (kind === KIND_CHANNEL_ADMINS) return jsonResponse([adminState()]);
        if (kind === KIND_CHANNEL_METADATA) {
          return jsonResponse([
            signed(owner, KIND_CHANNEL_METADATA, [
              ['d', communityId],
              ['name', projectedName],
              ...(projectedVisibility === 'private' ? [['private'], ['closed']] : []),
              ['picture', 'https://example.test/builders.png'],
            ]),
          ]);
        }
        return jsonResponse([]);
      }),
    );

    await expect(renameCommunity(ctx(), communityId, 'New Builders')).resolves.toMatchObject({
      name: 'New Builders',
      visibility: 'public',
    });
    await expect(setCommunityVisibility(ctx(), communityId, 'invite-only')).resolves.toMatchObject({
      visibility: 'invite-only',
    });
    expect(published.map((event) => tagValue(event, 'visibility'))).toEqual(['open', 'private']);
  });

  it('reads Workspace picture metadata while preserving the immutable create record', async () => {
    const create = communityCreate();
    const metadata = signed(
      owner,
      KIND_CHANNEL_METADATA,
      [
        ['d', communityId],
        ['name', 'Builders'],
        ['picture', 'https://media.example.test/newest.png'],
      ],
      create.created_at + 10,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const kind = (filterFrom(init).kinds as number[])[0];
        if (kind === KIND_CREATE_GROUP) return jsonResponse([create]);
        if (kind === KIND_CHANNEL_METADATA) return jsonResponse([metadata]);
        return jsonResponse([]);
      }),
    );

    await expect(getCommunity(ctx(invitee), communityId)).resolves.toMatchObject({
      communityId,
      avatar: 'https://media.example.test/newest.png',
      createdBy: owner.publicKey,
      ownerPubkey: owner.publicKey,
      createdAt: create.created_at,
      raw: create,
    });
  });

  it('mirrors current community members into a newly linked channel', async () => {
    const published: NostrEvent[] = [];
    const channelMemberPubkeys = new Set([owner.publicKey]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          const event = JSON.parse(String(init?.body)) as NostrEvent;
          published.push(event);
          if (event.kind === KIND_PUT_USER && tagValue(event, 'h') === channelId) {
            channelMemberPubkeys.add(tagValue(event, 'p')!);
          }
          return jsonResponse({ accepted: true });
        }
        const filter = filterFrom(init);
        if ((filter.kinds as number[])[0] !== KIND_CHANNEL_MEMBERS) return jsonResponse([]);
        const requestedId = (filter['#d'] as string[] | undefined)?.[0];
        if (requestedId === communityId) return jsonResponse([memberState(true)]);
        if (requestedId === channelId) {
          return jsonResponse([
            signed(owner, KIND_CHANNEL_MEMBERS, [
              ['d', channelId],
              ...[...channelMemberPubkeys].map((pubkey) => ['p', pubkey]),
            ]),
          ]);
        }
        return jsonResponse([]);
      }),
    );

    await expect(createChannel(ctx(), 'general', { channelId, communityId })).resolves.toBe(
      channelId,
    );

    const memberMutations = published.filter((event) => event.kind === KIND_PUT_USER);
    expect(memberMutations).toHaveLength(1);
    expect(tagValue(memberMutations[0]!, 'p')).toBe(invitee.publicKey);
    expect(tagValue(memberMutations[0]!, 'role')).toBe('member');
    expect(tagValue(memberMutations[0]!, TAG_COMMUNITY)).toBe(communityId);
    expect(channelMemberPubkeys).toEqual(new Set([owner.publicKey, invitee.publicKey]));
  });

  it('lists communities by member pubkey and preserves owner/member roles', async () => {
    const create = communityCreate();
    const metadata = signed(owner, KIND_CHANNEL_METADATA, [
      ['d', communityId],
      ['name', 'Builders'],
      ['picture', 'https://media.example.test/projected.png'],
    ]);
    const members = memberState(true);
    const admins = adminState();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const filter = filterFrom(init);
        const kinds = filter.kinds as number[];
        const kind = kinds[0];
        if (kind === KIND_CHANNEL_MEMBERS) return jsonResponse([members]);
        if (kind === KIND_CHANNEL_ADMINS) return jsonResponse([admins]);
        if (kind === KIND_CREATE_GROUP) {
          // Real relay semantics: create events and metadata events can be
          // requested as two separate filters in one query; the response is
          // the union of whichever filters they match, not just the first.
          const allFilters = JSON.parse(String(init?.body)) as Record<string, unknown>[];
          const wantsMetadata = allFilters.some((f) =>
            (f.kinds as number[] | undefined)?.includes(KIND_CHANNEL_METADATA),
          );
          return jsonResponse(wantsMetadata ? [create, metadata] : [create]);
        }
        return jsonResponse([]);
      }),
    );

    const listed = await listCommunities(ctx(invitee), invitee.publicKey);
    expect(listed).toMatchObject([
      {
        communityId,
        name: 'Builders',
        avatar: 'https://media.example.test/projected.png',
        viewerRole: 'member',
        createdBy: owner.publicKey,
        ownerPubkey: owner.publicKey,
      },
    ]);

    const roles = await communityMembers(ctx(invitee), communityId);
    expect(roles).toEqual(
      expect.arrayContaining([
        { pubkey: owner.publicKey, role: 'owner' },
        { pubkey: invitee.publicKey, role: 'member' },
      ]),
    );
  });

  it('resolves a non-creator owner marked at admin-tag index 3, not just index 2', async () => {
    // Regression: `channel.ts`'s listMembers and `repo-room.ts`'s
    // projectedRoomRole both accept the owner marker at tag[3] OR tag[2];
    // projectedCommunityRole previously only checked tag[2], so an owner
    // whose admin projection used the 4-element shape silently resolved as
    // 'admin'. `admin` (not the create-event signer) carries the owner
    // marker here so the `community.ownerPubkey === pubkey` shortcut in
    // listCommunities can't mask the bug.
    const create = communityCreate();
    const members = memberState();
    const admins = signed(owner, KIND_CHANNEL_ADMINS, [
      ['d', communityId],
      ['p', admin.publicKey, 'admin', 'owner'],
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const filter = filterFrom(init);
        const kinds = (filter.kinds ?? []) as number[];
        if (kinds.includes(KIND_CHANNEL_MEMBERS) && kinds.includes(KIND_CHANNEL_ADMINS)) {
          return jsonResponse([members, admins]);
        }
        if (kinds[0] === KIND_CHANNEL_ADMINS) return jsonResponse([admins]);
        if (kinds[0] === KIND_CHANNEL_MEMBERS) return jsonResponse([members]);
        if (kinds[0] === KIND_CREATE_GROUP) return jsonResponse([create]);
        return jsonResponse([]);
      }),
    );

    const listed = await listCommunities(ctx(admin), admin.publicKey);
    expect(listed).toMatchObject([{ communityId, viewerRole: 'owner', ownerPubkey: owner.publicKey }]);
  });

  it('keeps communities visible when membership projections also contain channel IDs', async () => {
    const create = communityCreate();
    const channelCreate = signed(owner, KIND_CREATE_GROUP, [
      ['h', channelId],
      ['name', 'general'],
      [TAG_COMMUNITY, communityId],
    ]);
    const channelMembers = signed(owner, KIND_CHANNEL_MEMBERS, [
      ['d', channelId],
      ['p', owner.publicKey],
    ]);
    const communityMembers = memberState();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const filter = filterFrom(init);
        const kind = (filter.kinds as number[])[0];
        if (kind === KIND_CHANNEL_MEMBERS) {
          return jsonResponse([channelMembers, communityMembers]);
        }
        if (kind === KIND_CREATE_GROUP) {
          const ids = filter['#h'] as string[] | undefined;
          if (!ids) return jsonResponse([channelCreate, create]);
          if (ids[0] === channelId) return jsonResponse([channelCreate]);
          if (ids[0] === communityId) return jsonResponse([create]);
        }
        return jsonResponse([]);
      }),
    );

    await expect(listCommunities(ctx(), owner.publicKey)).resolves.toMatchObject([
      { communityId, name: 'Builders', viewerRole: 'owner' },
    ]);
  });

  it('never ambiently repairs a registered agent into Workspace Rooms', async () => {
    const agentMarker = signed(invitee, KIND_STREAM_MESSAGE, [
      ['h', communityId],
      ['t', TAG_AGENT],
    ]);
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          published.push(JSON.parse(String(init?.body)) as NostrEvent);
          return jsonResponse({ accepted: true });
        }
        const filter = filterFrom(init);
        const kind = (filter.kinds as number[])[0];
        return kind === KIND_STREAM_MESSAGE ? jsonResponse([agentMarker]) : jsonResponse([]);
      }),
    );

    await expect(repairCommunityRoomMemberships(ctx(invitee), communityId)).resolves.toEqual([]);
    expect(published).toEqual([]);
  });
});

describe('leaveCommunity (workspace exit)', () => {
  function roomCreate(): NostrEvent {
    return signed(owner, KIND_CREATE_GROUP, [
      ['h', channelId],
      ['name', 'general'],
      [TAG_COMMUNITY, communityId],
    ]);
  }

  function stubLeaveRelay(options: {
    selfLeavesWorkspace: boolean;
    selfLeavesRoom: boolean;
    includeSelfInWorkspace: boolean;
    includeSelfInRoom: boolean;
    /** When false, publishes are accepted but the projections never change. */
    dropOnPublish?: boolean;
    workspaceMembers?: NostrEvent;
  }) {
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          const event = JSON.parse(String(init?.body)) as NostrEvent;
          published.push(event);
          if (options.dropOnPublish !== false) {
            if (event.kind === KIND_REMOVE_USER && tagValue(event, 'h') === channelId) {
              options.selfLeavesRoom = true;
            }
            if (event.kind === KIND_REMOVE_USER && tagValue(event, 'h') === communityId) {
              options.selfLeavesWorkspace = true;
            }
          }
          return jsonResponse({ accepted: true });
        }
        const filter = filterFrom(init);
        const kind = (filter.kinds as number[])[0];
        const requestedId = ((filter['#h'] ?? filter['#d']) as string[] | undefined)?.[0];
        if (kind === KIND_CREATE_GROUP) {
          return requestedId === channelId
            ? jsonResponse([roomCreate()])
            : jsonResponse([roomCreate()]);
        }
        if (kind === KIND_CHANNEL_ADMINS) {
          return requestedId === communityId ? jsonResponse([adminState()]) : jsonResponse([]);
        }
        if (kind === KIND_CHANNEL_MEMBERS) {
          if (requestedId === communityId) {
            return jsonResponse([
              options.workspaceMembers ??
                signed(owner, KIND_CHANNEL_MEMBERS, [
                  ['d', communityId],
                  ['p', owner.publicKey],
                  ...(options.includeSelfInWorkspace && !options.selfLeavesWorkspace
                    ? [['p', invitee.publicKey]]
                    : []),
                ] as string[][]),
            ]);
          }
          if (requestedId === channelId) {
            return jsonResponse([
              signed(owner, KIND_CHANNEL_MEMBERS, [
                ['d', channelId],
                ['p', owner.publicKey],
                ...(options.includeSelfInRoom && !options.selfLeavesRoom
                  ? [['p', invitee.publicKey]]
                  : []),
              ]),
            ]);
          }
        }
        return jsonResponse([]);
      }),
    );
    return published;
  }

  it('a member leaves via a self-authored removal after dropping Room memberships', async () => {
    const state = {
      selfLeavesWorkspace: false,
      selfLeavesRoom: false,
      includeSelfInWorkspace: true,
      includeSelfInRoom: true,
    };
    const published = stubLeaveRelay(state);

    await expect(
      leaveCommunity(ctx(invitee), communityId, { timeoutMs: 1_000 }),
    ).resolves.toBeUndefined();

    const roomLeave = published.find(
      (event) => event.kind === KIND_REMOVE_USER && tagValue(event, 'h') === channelId,
    );
    expect(roomLeave?.pubkey).toBe(invitee.publicKey);

    const workspaceLeave = published.find(
      (event) => event.kind === KIND_REMOVE_USER && tagValue(event, 'h') === communityId,
    );
    expect(workspaceLeave?.pubkey).toBe(invitee.publicKey);
    expect(tagValue(workspaceLeave!, TAG_COMMUNITY)).toBe(communityId);

    // The Workspace mutation comes last — Rooms drop first.
    const roomIndex = published.indexOf(roomLeave!);
    const workspaceIndex = published.indexOf(workspaceLeave!);
    expect(roomIndex).toBeGreaterThanOrEqual(0);
    expect(workspaceIndex).toBeGreaterThan(roomIndex);
  });

  it('refuses the sole owner up front with an actionable message and publishes nothing', async () => {
    const state = {
      selfLeavesWorkspace: false,
      selfLeavesRoom: false,
      includeSelfInWorkspace: true,
      includeSelfInRoom: true,
    };
    const published = stubLeaveRelay(state);

    await expect(leaveCommunity(ctx(owner), communityId, { timeoutMs: 200 })).rejects.toThrow(
      /only owner/,
    );
    expect(published).toEqual([]);
  });

  it('is idempotent when the member is already absent from the projection', async () => {
    const state = {
      selfLeavesWorkspace: true,
      selfLeavesRoom: false,
      includeSelfInWorkspace: false,
      includeSelfInRoom: false,
    };
    const published = stubLeaveRelay(state);

    await expect(
      leaveCommunity(ctx(invitee), communityId, { timeoutMs: 200 }),
    ).resolves.toBeUndefined();
    expect(published).toEqual([]);
  });

  it('surfaces an honest error when the relay never drops the membership projection', async () => {
    const state = {
      selfLeavesWorkspace: false,
      selfLeavesRoom: false,
      includeSelfInWorkspace: true,
      includeSelfInRoom: false,
      dropOnPublish: false,
    };
    stubLeaveRelay(state);

    await expect(
      leaveCommunity(ctx(invitee), communityId, { leaveRooms: false, timeoutMs: 300 }),
    ).rejects.toThrow(/membership still visible/);
  });
});

describe('community invites', () => {
  it('publishes only the token hash with expiry and signed minter identity', async () => {
    const create = communityCreate();
    const members = memberState();
    const admins = adminState();
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          published.push(JSON.parse(String(init?.body)) as NostrEvent);
          return jsonResponse({ accepted: true });
        }
        const kind = (filterFrom(init).kinds as number[])[0];
        if (kind === KIND_CREATE_GROUP) return jsonResponse([create]);
        if (kind === KIND_CHANNEL_MEMBERS) return jsonResponse([members]);
        if (kind === KIND_CHANNEL_ADMINS) return jsonResponse([admins]);
        return jsonResponse([]);
      }),
    );

    const invite = await createInvite(ctx(), communityId);
    const event = published[0]!;
    expect(invite.token).toMatch(/^bzi_[0-9a-f]{64}$/);
    expect(invite.tokenHash).toBe(inviteTokenHash(invite.token));
    expect(JSON.stringify(event)).not.toContain(invite.token);
    expect(event.kind).toBe(KIND_COMMUNITY_INVITE);
    expect(invite.expiresAt - event.created_at).toBe(DEFAULT_INVITE_TTL_SECONDS);
    expect(tagValues(event, 't')).toContain(TAG_COMMUNITY_INVITE);
    expect(tagValue(event, 'd')).toBe(invite.tokenHash);
    expect(tagValue(event, TAG_COMMUNITY)).toBe(communityId);
    expect(event.pubkey).toBe(owner.publicKey);
    expect(parseCommunityInvite(event)).toMatchObject({
      communityId,
      mintedBy: owner.publicKey,
      tokenHash: invite.tokenHash,
    });
    expect(parseCommunityInvite({ ...event, content: 'tampered' })).toBeNull();
  });

  it('keeps shorter explicit invite TTLs', async () => {
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          published.push(JSON.parse(String(init?.body)) as NostrEvent);
          return jsonResponse({ accepted: true });
        }
        const kind = (filterFrom(init).kinds as number[])[0];
        if (kind === KIND_CREATE_GROUP) return jsonResponse([communityCreate()]);
        if (kind === KIND_CHANNEL_MEMBERS) return jsonResponse([memberState()]);
        if (kind === KIND_CHANNEL_ADMINS) return jsonResponse([adminState()]);
        return jsonResponse([]);
      }),
    );

    const invite = await createInvite(ctx(), communityId, { expiresInSeconds: 3600 });
    expect(invite.expiresAt - published[0]!.created_at).toBe(3600);
  });

  it("lists and revokes the current admin's active invite", async () => {
    const createdAt = Math.floor(Date.now() / 1000) - 10;
    const tokenHash = 'ab'.repeat(32);
    const invite = signed(
      owner,
      KIND_COMMUNITY_INVITE,
      [
        ['h', communityId],
        ['t', TAG_COMMUNITY_INVITE],
        ['d', tokenHash],
        [TAG_COMMUNITY, communityId],
        ['expiration', String(createdAt + 3600)],
        ['role', 'member'],
      ],
      createdAt,
    );
    const events = [invite];
    const inviteFilters: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          events.push(JSON.parse(String(init?.body)) as NostrEvent);
          return jsonResponse({ accepted: true });
        }
        const filter = filterFrom(init);
        const kind = (filter.kinds as number[])[0];
        if (kind === KIND_COMMUNITY_INVITE) {
          inviteFilters.push(filter);
          return jsonResponse(events);
        }
        if (kind === KIND_CREATE_GROUP) return jsonResponse([communityCreate()]);
        if (kind === KIND_CHANNEL_MEMBERS) return jsonResponse([memberState()]);
        if (kind === KIND_CHANNEL_ADMINS) return jsonResponse([adminState()]);
        return jsonResponse([]);
      }),
    );

    await expect(listCommunityInvites(ctx(), communityId)).resolves.toMatchObject([{ tokenHash }]);
    expect(inviteFilters[0]).not.toHaveProperty('#h');
    await expect(revokeCommunityInvite(ctx(), communityId, tokenHash)).resolves.toBeUndefined();
    expect(tagValue(events[1]!, 'revoked')).toBe('true');
    await expect(listCommunityInvites(ctx(), communityId)).resolves.toEqual([]);
    await expect(findCommunityInvite(ctx().http, tokenHash, owner.publicKey)).resolves.toBeNull();
  });

  it('falls back to the marker-tag scan for legacy group-scoped invites', async () => {
    const token = 'bzi_' + 'fa'.repeat(32);
    const tokenHash = inviteTokenHash(token);
    const createdAt = Math.floor(Date.now() / 1000) - 10;
    const invite = signed(
      owner,
      KIND_STREAM_MESSAGE,
      [
        ['h', communityId],
        ['t', TAG_COMMUNITY_INVITE],
        ['d', tokenHash],
        [TAG_COMMUNITY, communityId],
        ['expiration', String(createdAt + 3600)],
      ],
      createdAt,
    );
    const filters: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const filter = filterFrom(init);
        filters.push(filter);
        return jsonResponse(filter.kinds?.[0] === KIND_STREAM_MESSAGE ? [invite] : []);
      }),
    );

    await expect(
      findCommunityInvite(ctx().http, tokenHash, owner.publicKey),
    ).resolves.toMatchObject({
      tokenHash,
      communityId,
    });
    expect(filters).toEqual([
      expect.objectContaining({ kinds: [KIND_COMMUNITY_INVITE], '#d': [tokenHash] }),
      expect.objectContaining({
        kinds: [KIND_STREAM_MESSAGE],
        '#t': [TAG_COMMUNITY_INVITE],
      }),
    ]);
  });

  it('rejects an invite signed by a non-member', async () => {
    const token = 'bzi_' + 'ef'.repeat(32);
    const tokenHash = inviteTokenHash(token);
    const createdAt = Math.floor(Date.now() / 1000) - 10;
    const invite = signed(
      outsider,
      KIND_STREAM_MESSAGE,
      [
        ['h', communityId],
        ['t', TAG_COMMUNITY_INVITE],
        ['d', tokenHash],
        [TAG_COMMUNITY, communityId],
        ['expiration', String(createdAt + 3600)],
      ],
      createdAt,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const kind = (filterFrom(init).kinds as number[])[0];
        if (kind === KIND_STREAM_MESSAGE) return jsonResponse([invite]);
        if (kind === KIND_CREATE_GROUP) return jsonResponse([communityCreate()]);
        if (kind === KIND_CHANNEL_ADMINS) return jsonResponse([adminState()]);
        if (kind === KIND_CHANNEL_MEMBERS) return jsonResponse([memberState(false)]);
        return jsonResponse([]);
      }),
    );

    await expect(redeemInvite(ctx(invitee), token)).rejects.toThrow(
      'invite minter is not a community member',
    );
  });

  it('redeems once through kind:9000 and treats a repeat as already joined', async () => {
    const token = 'bzi_' + 'ab'.repeat(32);
    const tokenHash = inviteTokenHash(token);
    const createdAt = Math.floor(Date.now() / 1000) - 10;
    const invite = signed(
      owner,
      KIND_STREAM_MESSAGE,
      [
        ['h', communityId],
        ['t', TAG_COMMUNITY_INVITE],
        ['d', tokenHash],
        [TAG_COMMUNITY, communityId],
        ['expiration', String(createdAt + 3600)],
        ['role', 'member'],
      ],
      createdAt,
    );
    let joined = false;
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          const event = JSON.parse(String(init?.body)) as NostrEvent;
          published.push(event);
          if (event.kind === KIND_PUT_USER) joined = true;
          return jsonResponse({ accepted: true });
        }
        const kind = (filterFrom(init).kinds as number[])[0];
        if (kind === KIND_STREAM_MESSAGE) return jsonResponse([invite]);
        if (kind === KIND_CREATE_GROUP) return jsonResponse([communityCreate()]);
        if (kind === KIND_CHANNEL_ADMINS) return jsonResponse([adminState()]);
        if (kind === KIND_CHANNEL_MEMBERS) return jsonResponse([memberState(joined)]);
        return jsonResponse([]);
      }),
    );

    await expect(redeemInvite(ctx(invitee), token)).resolves.toMatchObject({
      communityId,
      joined: true,
      alreadyMember: false,
    });
    expect(published).toHaveLength(1);
    expect(published[0]?.kind).toBe(KIND_PUT_USER);
    expect(tagValue(published[0]!, 'p')).toBe(invitee.publicKey);
    expect(tagValue(published[0]!, 'invite')).toBe(tokenHash);

    await expect(redeemInvite(ctx(invitee), token)).resolves.toMatchObject({
      joined: false,
      alreadyMember: true,
    });
    expect(published).toHaveLength(1);
  });

  it('lets two identities redeem the same current invite without consuming its marker', async () => {
    const token = 'bzi_' + 'ac'.repeat(32);
    const tokenHash = inviteTokenHash(token);
    const createdAt = Math.floor(Date.now() / 1000) - 10;
    const invite = signed(
      owner,
      KIND_COMMUNITY_INVITE,
      [
        ['h', communityId],
        ['t', TAG_COMMUNITY_INVITE],
        ['d', tokenHash],
        [TAG_COMMUNITY, communityId],
        ['expiration', String(createdAt + 3600)],
        ['role', 'member'],
      ],
      createdAt,
    );
    const joined = new Set<string>();
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          const event = JSON.parse(String(init?.body)) as NostrEvent;
          published.push(event);
          if (event.kind === KIND_PUT_USER) joined.add(tagValue(event, 'p')!);
          return jsonResponse({ accepted: true });
        }
        const filter = filterFrom(init);
        const kind = (filter.kinds as number[])[0];
        if (kind === KIND_COMMUNITY_INVITE) return jsonResponse([invite]);
        if (kind === KIND_CREATE_GROUP) return jsonResponse([communityCreate()]);
        if (kind === KIND_CHANNEL_ADMINS) return jsonResponse([adminState()]);
        if (kind === KIND_CHANNEL_MEMBERS) {
          return jsonResponse([
            signed(owner, KIND_CHANNEL_MEMBERS, [
              ['d', communityId],
              ['p', owner.publicKey],
              ...[...joined].map((pubkey) => ['p', pubkey]),
            ]),
          ]);
        }
        return jsonResponse([]);
      }),
    );

    await expect(redeemInvite(ctx(invitee), token)).resolves.toMatchObject({ joined: true });
    await expect(redeemInvite(ctx(outsider), token)).resolves.toMatchObject({ joined: true });
    expect(joined).toEqual(new Set([invitee.publicKey, outsider.publicKey]));
    expect(published.filter((event) => event.kind === KIND_PUT_USER)).toHaveLength(2);
  });

  it('asserts invite membership into existing community channels and repairs repeats', async () => {
    const token = 'bzi_' + 'bc'.repeat(32);
    const tokenHash = inviteTokenHash(token);
    const createdAt = Math.floor(Date.now() / 1000) - 10;
    const invite = signed(
      owner,
      KIND_STREAM_MESSAGE,
      [
        ['h', communityId],
        ['t', TAG_COMMUNITY_INVITE],
        ['d', tokenHash],
        [TAG_COMMUNITY, communityId],
        ['expiration', String(createdAt + 3600)],
        ['role', 'member'],
      ],
      createdAt,
    );
    const channelCreate = signed(owner, KIND_CREATE_GROUP, [
      ['h', channelId],
      ['name', 'general'],
      ['channel_type', 'stream'],
      ['visibility', 'open'],
      [TAG_COMMUNITY, communityId],
    ]);
    const cornerId = '33333333-3333-4333-8333-333333333333';
    const archivedRoomId = '44444444-4444-4444-8444-444444444444';
    const cornerCreate = signed(owner, KIND_CREATE_GROUP, [
      ['h', cornerId],
      ['name', 'finished-corner'],
      ['parent', channelId],
      [TAG_COMMUNITY, communityId],
    ]);
    const archivedRoomCreate = signed(owner, KIND_CREATE_GROUP, [
      ['h', archivedRoomId],
      ['name', 'old-room'],
      [TAG_COMMUNITY, communityId],
    ]);
    let communityJoined = false;
    let channelJoined = false;
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          const event = JSON.parse(String(init?.body)) as NostrEvent;
          published.push(event);
          if (event.kind === KIND_PUT_USER && tagValue(event, 'p') === invitee.publicKey) {
            if (tagValue(event, 'h') === communityId) communityJoined = true;
            if (tagValue(event, 'h') === channelId) channelJoined = true;
          }
          return jsonResponse({ accepted: true });
        }
        const filter = filterFrom(init);
        const kind = (filter.kinds as number[])[0];
        if (kind === KIND_CHANNEL_METADATA) {
          const requestedId = (filter['#d'] as string[] | undefined)?.[0];
          return requestedId === archivedRoomId
            ? jsonResponse([
                signed(owner, KIND_CHANNEL_METADATA, [
                  ['d', archivedRoomId],
                  ['archived', 'true'],
                ]),
              ])
            : jsonResponse([]);
        }
        if (kind === KIND_STREAM_MESSAGE) return jsonResponse([invite]);
        if (kind === KIND_CHANNEL_ADMINS) return jsonResponse([adminState()]);
        if (kind === KIND_CHANNEL_MEMBERS) {
          const requestedId = (filter['#d'] as string[] | undefined)?.[0];
          if (requestedId === communityId) return jsonResponse([memberState(communityJoined)]);
          if (requestedId === channelId) {
            return jsonResponse([
              signed(owner, KIND_CHANNEL_MEMBERS, [
                ['d', channelId],
                ['p', owner.publicKey],
                ...(channelJoined ? [['p', invitee.publicKey]] : []),
              ]),
            ]);
          }
        }
        if (kind === KIND_CREATE_GROUP) {
          const requestedId = (filter['#h'] as string[] | undefined)?.[0];
          if (requestedId === communityId) return jsonResponse([communityCreate()]);
          if (requestedId === channelId) return jsonResponse([channelCreate]);
          return jsonResponse([communityCreate(), channelCreate, cornerCreate, archivedRoomCreate]);
        }
        return jsonResponse([]);
      }),
    );

    await expect(redeemInvite(ctx(invitee), token)).resolves.toMatchObject({
      communityId,
      joined: true,
      alreadyMember: false,
    });
    expect(published.filter((event) => event.kind === KIND_PUT_USER)).toHaveLength(2);
    const channelMutation = published.find(
      (event) => event.kind === KIND_PUT_USER && tagValue(event, 'h') === channelId,
    );
    expect(channelMutation).toBeDefined();
    expect(tagValue(channelMutation!, 'p')).toBe(invitee.publicKey);
    expect(tagValue(channelMutation!, 'role')).toBe('member');
    expect(tagValue(channelMutation!, TAG_COMMUNITY)).toBe(communityId);
    expect(
      published.some(
        (event) =>
          event.kind === KIND_PUT_USER &&
          [cornerId, archivedRoomId].includes(tagValue(event, 'h') ?? ''),
      ),
    ).toBe(false);

    channelJoined = false;
    await expect(redeemInvite(ctx(invitee), token)).resolves.toMatchObject({
      joined: false,
      alreadyMember: true,
    });
    expect(published.filter((event) => event.kind === KIND_PUT_USER)).toHaveLength(3);
    expect(channelJoined).toBe(true);
  });

  it('fails an archived Workspace invite with an actionable error before publishing', async () => {
    const token = 'bzi_' + 'de'.repeat(32);
    const tokenHash = inviteTokenHash(token);
    const createdAt = Math.floor(Date.now() / 1000) - 10;
    const invite = signed(
      owner,
      KIND_STREAM_MESSAGE,
      [
        ['h', communityId],
        ['t', TAG_COMMUNITY_INVITE],
        ['d', tokenHash],
        [TAG_COMMUNITY, communityId],
        ['expiration', String(createdAt + 3600)],
        ['role', 'member'],
      ],
      createdAt,
    );
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          published.push(JSON.parse(String(init?.body)) as NostrEvent);
          return jsonResponse({ accepted: true });
        }
        const filter = filterFrom(init);
        const kind = (filter.kinds as number[])[0];
        if (kind === KIND_STREAM_MESSAGE) return jsonResponse([invite]);
        if (kind === KIND_CREATE_GROUP) return jsonResponse([communityCreate()]);
        if (kind === KIND_CHANNEL_ADMINS) return jsonResponse([adminState()]);
        if (kind === KIND_CHANNEL_MEMBERS) return jsonResponse([memberState(false)]);
        if (kind === KIND_CHANNEL_METADATA) {
          return jsonResponse([
            signed(owner, KIND_CHANNEL_METADATA, [
              ['d', communityId],
              ['archived', 'true'],
            ]),
          ]);
        }
        return jsonResponse([]);
      }),
    );

    await expect(redeemInvite(ctx(invitee), token)).rejects.toThrow(
      'This Workspace is archived. Ask a Workspace admin to restore it before joining.',
    );
    expect(published).toHaveLength(0);
  });

  it('rejects an expired invite for a new member', async () => {
    const token = 'bzi_' + 'cd'.repeat(32);
    const tokenHash = inviteTokenHash(token);
    const invite = signed(
      owner,
      KIND_STREAM_MESSAGE,
      [
        ['h', communityId],
        ['t', TAG_COMMUNITY_INVITE],
        ['d', tokenHash],
        [TAG_COMMUNITY, communityId],
        ['expiration', '1700000010'],
        ['role', 'member'],
      ],
      1_700_000_000,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const kind = (filterFrom(init).kinds as number[])[0];
        if (kind === KIND_STREAM_MESSAGE) return jsonResponse([invite]);
        if (kind === KIND_CREATE_GROUP) return jsonResponse([communityCreate()]);
        if (kind === KIND_CHANNEL_ADMINS) return jsonResponse([adminState()]);
        if (kind === KIND_CHANNEL_MEMBERS) return jsonResponse([memberState(false)]);
        return jsonResponse([]);
      }),
    );

    await expect(redeemInvite(ctx(invitee), token)).rejects.toThrow('invite has expired');
  });
});
