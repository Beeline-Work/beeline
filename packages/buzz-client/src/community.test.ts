import { afterEach, describe, expect, it, vi } from 'vitest';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import { createChannel, type ChannelOpsContext } from './channel.js';
import {
  attachCommunityMemberToChannel,
  communityMembers,
  createCommunity,
  createInvite,
  inviteTokenHash,
  listCommunities,
  parseCommunityInvite,
  redeemInvite,
} from './community.js';
import { createIdentity } from './identity.js';
import {
  KIND_CHANNEL_ADMINS,
  KIND_CHANNEL_MEMBERS,
  KIND_CREATE_GROUP,
  KIND_PUT_USER,
  KIND_STREAM_MESSAGE,
  TAG_COMMUNITY,
  TAG_COMMUNITY_INVITE,
} from './kinds.js';
import { tagValue, tagValues } from './parse.js';

const communityId = '11111111-1111-4111-8111-111111111111';
const channelId = '22222222-2222-4222-8222-222222222222';
const owner = createIdentity('owner');
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
    const members = memberState(true);
    const admins = adminState();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const filter = filterFrom(init);
        const kind = (filter.kinds as number[])[0];
        if (kind === KIND_CHANNEL_MEMBERS) return jsonResponse([members]);
        if (kind === KIND_CHANNEL_ADMINS) return jsonResponse([admins]);
        if (kind === KIND_CREATE_GROUP) return jsonResponse([create]);
        return jsonResponse([]);
      }),
    );

    const listed = await listCommunities(ctx(invitee), invitee.publicKey);
    expect(listed).toMatchObject([
      {
        communityId,
        name: 'Builders',
        avatar: 'https://example.test/builders.png',
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
      { communityId, name: 'Builders' },
    ]);
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

    const invite = await createInvite(ctx(), communityId, { expiresInSeconds: 3600 });
    const event = published[0]!;
    expect(invite.token).toMatch(/^bzi_[0-9a-f]{64}$/);
    expect(invite.tokenHash).toBe(inviteTokenHash(invite.token));
    expect(JSON.stringify(event)).not.toContain(invite.token);
    expect(event.kind).toBe(KIND_STREAM_MESSAGE);
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
          return jsonResponse([communityCreate(), channelCreate]);
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

    channelJoined = false;
    await expect(redeemInvite(ctx(invitee), token)).resolves.toMatchObject({
      joined: false,
      alreadyMember: true,
    });
    expect(published.filter((event) => event.kind === KIND_PUT_USER)).toHaveLength(3);
    expect(channelJoined).toBe(true);
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
