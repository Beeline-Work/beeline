import { afterEach, describe, expect, it, vi } from 'vitest';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import {
  createAgentPairingCode,
  listAgents,
  parseAgentSoul,
  redeemAgentPairingCode,
  setAgentSoul,
} from './agent.js';
import { createAgentIdentity, createIdentity } from './identity.js';
import {
  KIND_AGENT_SOUL,
  KIND_CHANNEL_ADMINS,
  KIND_CHANNEL_MEMBERS,
  KIND_CHANNEL_METADATA,
  KIND_COMMUNITY_INVITE,
  KIND_CREATE_GROUP,
  KIND_PUT_USER,
  KIND_STREAM_MESSAGE,
  TAG_AGENT,
  TAG_AGENT_PAIRING,
  TAG_AGENT_SOUL,
  TAG_COMMUNITY,
  TAG_DIRECT_MESSAGE,
  TAG_PARENT,
} from './kinds.js';
import { tagValue, tagValues } from './parse.js';
import type { ChannelOpsContext } from './channel.js';

const communityId = '11111111-1111-4111-8111-111111111111';
const owner = createIdentity('owner');
const agentIdentity = createAgentIdentity('Hull runner');
const outsider = createIdentity('outsider');
const http = { baseUrl: 'http://relay.test', host: 'relay.test' };

function ctx(identity = owner): ChannelOpsContext {
  return { http: { ...http, identity }, identity };
}

function signed(identity: typeof owner, kind: number, tags: string[][]): NostrEvent {
  return signEvent(
    {
      pubkey: identity.publicKey,
      created_at: Math.floor(Date.now() / 1000),
      kind,
      tags,
      content: '',
    },
    identity.secretKey,
  );
}

function communityCreate(): NostrEvent {
  return signed(owner, KIND_CREATE_GROUP, [
    ['h', communityId],
    ['name', 'Builders'],
    [TAG_COMMUNITY, communityId],
  ]);
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function filterFrom(init?: RequestInit): Record<string, unknown> {
  return (JSON.parse(String(init?.body)) as Record<string, unknown>[])[0] ?? {};
}

afterEach(() => vi.unstubAllGlobals());

describe('agent pairing and soul overlays', () => {
  it("refuses to redeem the installer's pairing code under that same human key", async () => {
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
        if (kind === KIND_CREATE_GROUP) return jsonResponse([communityCreate()]);
        if (kind === KIND_CHANNEL_MEMBERS) {
          return jsonResponse([
            signed(owner, KIND_CHANNEL_MEMBERS, [
              ['d', communityId],
              ['p', owner.publicKey],
            ]),
          ]);
        }
        if (kind === KIND_CHANNEL_ADMINS) {
          return jsonResponse([
            signed(owner, KIND_CHANNEL_ADMINS, [
              ['d', communityId],
              ['p', owner.publicKey, 'owner'],
            ]),
          ]);
        }
        if (kind === KIND_COMMUNITY_INVITE || kind === KIND_STREAM_MESSAGE) {
          const requiredTags = (filter['#t'] as string[] | undefined) ?? [];
          const dValues = (filter['#d'] as string[] | undefined) ?? [];
          const pairingHashes = (filter['#pairing'] as string[] | undefined) ?? [];
          return jsonResponse(
            published.filter(
              (event) =>
                event.kind === kind &&
                requiredTags.every((tag) => tagValues(event, 't').includes(tag)) &&
                dValues.every((value) => tagValue(event, 'd') === value) &&
                pairingHashes.every((hash) => tagValue(event, 'pairing') === hash),
            ),
          );
        }
        return jsonResponse([]);
      }),
    );

    const pairing = await createAgentPairingCode(ctx(owner), communityId, 600);
    await expect(redeemAgentPairingCode(ctx(owner), pairing.code)).rejects.toThrow(
      "cannot pair the installer's human identity as its own agent",
    );
    expect(published.some((event) => tagValues(event, 't').includes(TAG_AGENT))).toBe(false);
  });

  it('refuses to turn any existing human Workspace member into the paired agent', async () => {
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
        if (kind === KIND_CREATE_GROUP) return jsonResponse([communityCreate()]);
        if (kind === KIND_CHANNEL_MEMBERS) {
          return jsonResponse([
            signed(owner, KIND_CHANNEL_MEMBERS, [
              ['d', communityId],
              ['p', owner.publicKey],
              ['p', outsider.publicKey],
            ]),
          ]);
        }
        if (kind === KIND_CHANNEL_ADMINS) return jsonResponse([]);
        if (kind === KIND_COMMUNITY_INVITE || kind === KIND_STREAM_MESSAGE) {
          const requiredTags = (filter['#t'] as string[] | undefined) ?? [];
          const dValues = (filter['#d'] as string[] | undefined) ?? [];
          const pairingHashes = (filter['#pairing'] as string[] | undefined) ?? [];
          return jsonResponse(
            published.filter(
              (event) =>
                event.kind === kind &&
                requiredTags.every((tag) => tagValues(event, 't').includes(tag)) &&
                dValues.every((value) => tagValue(event, 'd') === value) &&
                pairingHashes.every((hash) => tagValue(event, 'pairing') === hash),
            ),
          );
        }
        return jsonResponse([]);
      }),
    );

    const pairing = await createAgentPairingCode(ctx(owner), communityId, 600);
    await expect(redeemAgentPairingCode(ctx(outsider), pairing.code)).rejects.toThrow(
      'cannot pair existing human Workspace member',
    );
    expect(published.some((event) => tagValues(event, 't').includes(TAG_AGENT))).toBe(false);
  });

  it('redeems a globally resolvable code under the agent identity and is idempotent for that key', async () => {
    const published: NostrEvent[] = [];
    let agentIsMember = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          const event = JSON.parse(String(init?.body)) as NostrEvent;
          published.push(event);
          if (event.kind === KIND_PUT_USER && tagValue(event, 'p') === agentIdentity.publicKey) {
            agentIsMember = true;
          }
          return jsonResponse({ accepted: true });
        }
        const filter = filterFrom(init);
        const kind = (filter.kinds as number[])[0];
        if (kind === KIND_CREATE_GROUP) return jsonResponse([communityCreate()]);
        if (kind === KIND_CHANNEL_MEMBERS) {
          return jsonResponse([
            signed(owner, KIND_CHANNEL_MEMBERS, [
              ['d', communityId],
              ['p', owner.publicKey],
              ...(agentIsMember ? [['p', agentIdentity.publicKey]] : []),
            ]),
          ]);
        }
        if (kind === KIND_CHANNEL_ADMINS) {
          return jsonResponse([
            signed(owner, KIND_CHANNEL_ADMINS, [
              ['d', communityId],
              ['p', owner.publicKey, 'owner'],
            ]),
          ]);
        }
        if (kind === KIND_COMMUNITY_INVITE || kind === KIND_STREAM_MESSAGE) {
          const requiredTags = (filter['#t'] as string[] | undefined) ?? [];
          const dValues = (filter['#d'] as string[] | undefined) ?? [];
          const pairingHashes = (filter['#pairing'] as string[] | undefined) ?? [];
          return jsonResponse(
            published.filter(
              (event) =>
                event.kind === kind &&
                requiredTags.every((tag) => tagValues(event, 't').includes(tag)) &&
                dValues.every((value) => tagValue(event, 'd') === value) &&
                pairingHashes.every((hash) => tagValue(event, 'pairing') === hash),
            ),
          );
        }
        return jsonResponse([]);
      }),
    );

    const pairing = await createAgentPairingCode(ctx(), communityId, 600);
    expect(pairing.code).toMatch(/^BUZZ-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(JSON.stringify(pairing.event)).not.toContain(pairing.code);
    expect(pairing.event.kind).toBe(KIND_COMMUNITY_INVITE);
    expect(pairing.event.tags).toContainEqual(['t', TAG_AGENT_PAIRING]);

    const first = await redeemAgentPairingCode(ctx(agentIdentity), pairing.code.toLowerCase());
    expect(first).toMatchObject({ communityId, joined: true });
    expect(first.agent.pubkey).toBe(agentIdentity.publicKey);
    expect(first.agent.raw.tags).toContainEqual(['t', TAG_AGENT]);
    expect(first.agent.raw.pubkey).toBe(agentIdentity.publicKey);

    const second = await redeemAgentPairingCode(ctx(agentIdentity), pairing.code);
    expect(second).toMatchObject({ communityId, joined: false });
    expect(published.filter((event) => tagValues(event, 't').includes(TAG_AGENT))).toHaveLength(1);
  });

  it('redemption attaches the agent to every top-level Room the inviter belongs to, excluding DMs, corners, and archived Rooms', async () => {
    const roomAId = '22222222-2222-4222-8222-222222222222';
    const roomBId = '33333333-3333-4333-8333-333333333333';
    const cornerId = '44444444-4444-4444-8444-444444444444';
    const dmId = '55555555-5555-4555-8555-555555555555';
    const archivedRoomId = '66666666-6666-4666-8666-666666666666';
    const roomACreate = signed(owner, KIND_CREATE_GROUP, [
      ['h', roomAId],
      ['name', 'room-a'],
      [TAG_COMMUNITY, communityId],
    ]);
    const roomBCreate = signed(owner, KIND_CREATE_GROUP, [
      ['h', roomBId],
      ['name', 'room-b'],
      [TAG_COMMUNITY, communityId],
    ]);
    const cornerCreate = signed(owner, KIND_CREATE_GROUP, [
      ['h', cornerId],
      ['name', 'a-corner'],
      [TAG_PARENT, roomAId],
      [TAG_COMMUNITY, communityId],
    ]);
    const dmCreate = signed(owner, KIND_CREATE_GROUP, [
      ['h', dmId],
      ['t', TAG_DIRECT_MESSAGE],
      [TAG_COMMUNITY, communityId],
    ]);
    const archivedRoomCreate = signed(owner, KIND_CREATE_GROUP, [
      ['h', archivedRoomId],
      ['name', 'old-room'],
      [TAG_COMMUNITY, communityId],
    ]);
    // Owner (the pairing code's minter) belongs to room A and the archived
    // room, but not room B — room B must never receive the agent even though
    // it's an ordinary top-level Room in the same Workspace.
    const roomMembers: Record<string, Set<string>> = {
      [roomAId]: new Set([owner.publicKey]),
      [roomBId]: new Set(),
      [cornerId]: new Set([owner.publicKey]),
      [dmId]: new Set([owner.publicKey]),
      [archivedRoomId]: new Set([owner.publicKey]),
    };
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          const event = JSON.parse(String(init?.body)) as NostrEvent;
          published.push(event);
          if (event.kind === KIND_PUT_USER) {
            const channelId = tagValue(event, 'h');
            const pubkey = tagValue(event, 'p');
            if (channelId && pubkey) (roomMembers[channelId] ??= new Set()).add(pubkey);
          }
          return jsonResponse({ accepted: true });
        }
        const filter = filterFrom(init);
        const kind = (filter.kinds as number[])[0];
        if (kind === KIND_CREATE_GROUP) {
          return jsonResponse([
            communityCreate(),
            roomACreate,
            roomBCreate,
            cornerCreate,
            dmCreate,
            archivedRoomCreate,
          ]);
        }
        if (kind === KIND_CHANNEL_METADATA) {
          const requestedId =
            (filter['#d'] as string[] | undefined)?.[0] ?? (filter['#h'] as string[] | undefined)?.[0];
          if (requestedId === archivedRoomId) {
            return jsonResponse([
              signed(owner, KIND_CHANNEL_METADATA, [['d', archivedRoomId], ['archived', 'true']]),
            ]);
          }
          return jsonResponse([]);
        }
        if (kind === KIND_CHANNEL_ADMINS) return jsonResponse([]);
        if (kind === KIND_CHANNEL_MEMBERS) {
          const requestedId = (filter['#d'] as string[] | undefined)?.[0] ?? '';
          const members = [...(roomMembers[requestedId] ?? [])];
          return jsonResponse([
            signed(owner, KIND_CHANNEL_MEMBERS, [
              ['d', requestedId],
              ...members.map((pubkey) => ['p', pubkey]),
            ]),
          ]);
        }
        if (kind === KIND_STREAM_MESSAGE) {
          const requiredTags = (filter['#t'] as string[] | undefined) ?? [];
          const pairingHashes = (filter['#pairing'] as string[] | undefined) ?? [];
          return jsonResponse(
            published.filter(
              (event) =>
                event.kind === KIND_STREAM_MESSAGE &&
                requiredTags.every((tag) => tagValues(event, 't').includes(tag)) &&
                pairingHashes.every((hash) => tagValue(event, 'pairing') === hash),
            ),
          );
        }
        return jsonResponse([]);
      }),
    );

    const pairing = await createAgentPairingCode(ctx(owner), communityId, 600);
    await redeemAgentPairingCode(ctx(agentIdentity), pairing.code);

    expect(roomMembers[roomAId]!.has(agentIdentity.publicKey)).toBe(true);
    expect(roomMembers[roomBId]!.has(agentIdentity.publicKey)).toBe(false);
    expect(roomMembers[cornerId]!.has(agentIdentity.publicKey)).toBe(false);
    expect(roomMembers[dmId]!.has(agentIdentity.publicKey)).toBe(false);
    expect(roomMembers[archivedRoomId]!.has(agentIdentity.publicKey)).toBe(false);

    const attachPublishes = published.filter(
      (event) => event.kind === KIND_PUT_USER && tagValue(event, 'p') === agentIdentity.publicKey,
    );
    expect(attachPublishes).toHaveLength(2); // the Workspace itself + room A
    expect(attachPublishes.some((event) => tagValue(event, 'h') === roomAId)).toBe(true);
  });

  it('joins a member-authored replaceable soul overlay without changing identity authority', async () => {
    const published: NostrEvent[] = [];
    let agentHasHumanProfile = false;
    const agentRecord = signEvent(
      {
        pubkey: agentIdentity.publicKey,
        created_at: 1_700_000_000,
        kind: KIND_STREAM_MESSAGE,
        tags: [
          ['h', communityId],
          ['d', 'agent-id'],
          ['p', agentIdentity.publicKey],
          ['name', 'Agent'],
          ['t', TAG_AGENT],
          [TAG_COMMUNITY, communityId],
        ],
        content: JSON.stringify({ displayName: 'Agent' }),
      },
      agentIdentity.secretKey,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          published.push(JSON.parse(String(init?.body)) as NostrEvent);
          return jsonResponse({ accepted: true });
        }
        const kind = (filterFrom(init).kinds as number[])[0];
        if (kind === KIND_CREATE_GROUP) return jsonResponse([communityCreate()]);
        if (kind === KIND_CHANNEL_MEMBERS) {
          return jsonResponse([
            signed(owner, KIND_CHANNEL_MEMBERS, [
              ['d', communityId],
              ['p', owner.publicKey],
              ['p', agentIdentity.publicKey],
            ]),
          ]);
        }
        if (kind === KIND_CHANNEL_ADMINS) {
          return jsonResponse([signed(owner, KIND_CHANNEL_ADMINS, [['d', communityId]])]);
        }
        if (kind === KIND_STREAM_MESSAGE) {
          const authors = filterFrom(init).authors as string[] | undefined;
          return jsonResponse(
            !authors || authors.includes(agentRecord.pubkey) ? [agentRecord] : [],
          );
        }
        if (kind === 0 && agentHasHumanProfile) {
          return jsonResponse([
            signEvent(
              {
                pubkey: agentIdentity.publicKey,
                created_at: 1_700_000_001,
                kind: 0,
                tags: [],
                content: JSON.stringify({ name: 'human', display_name: 'Human' }),
              },
              agentIdentity.secretKey,
            ),
          ]);
        }
        if (kind === KIND_AGENT_SOUL) return jsonResponse(published.filter((e) => e.kind === kind));
        return jsonResponse([]);
      }),
    );

    const profile = await setAgentSoul(ctx(), communityId, agentIdentity.publicKey, {
      name: 'Ada',
      soul: 'Keeps the suite green and refactors mercilessly. Keep the test suite green and refactor mercilessly.',
      avatarSeed: agentIdentity.publicKey,
      avatar: 'https://relay.test/media/ada.jpg',
    });
    expect(profile.raw.pubkey).toBe(owner.publicKey);
    expect(profile.raw.kind).toBe(KIND_AGENT_SOUL);
    expect(profile.raw.tags).toContainEqual(['t', TAG_AGENT_SOUL]);

    published.push(
      signEvent(
        {
          pubkey: outsider.publicKey,
          created_at: profile.updatedAt + 10,
          kind: KIND_AGENT_SOUL,
          tags: [
            ['d', `${communityId}:${agentIdentity.publicKey}`],
            ['h', communityId],
            ['p', agentIdentity.publicKey],
            ['t', TAG_AGENT_SOUL],
            [TAG_COMMUNITY, communityId],
          ],
          content: JSON.stringify({
            name: 'Authority Impostor',
            personality: 'Claims permissions it does not have.',
            avatarSeed: 'malicious',
          }),
        },
        outsider.secretKey,
      ),
    );
    published.push(
      signEvent(
        {
          pubkey: agentIdentity.publicKey,
          created_at: profile.updatedAt + 20,
          kind: KIND_AGENT_SOUL,
          tags: [
            ['d', `${communityId}:${agentIdentity.publicKey}`],
            ['h', communityId],
            ['p', agentIdentity.publicKey],
            ['t', TAG_AGENT_SOUL],
            [TAG_COMMUNITY, communityId],
          ],
          content: JSON.stringify({
            name: 'Self Authored',
            personality: 'An agent cannot replace its human-authored profile.',
            avatarSeed: agentIdentity.publicKey,
          }),
        },
        agentIdentity.secretKey,
      ),
    );

    await expect(listAgents(ctx(), communityId)).resolves.toMatchObject([
      {
        pubkey: agentIdentity.publicKey,
        displayName: 'Ada',
        avatar: 'https://relay.test/media/ada.jpg',
        personality:
          'Keeps the suite green and refactors mercilessly. Keep the test suite green and refactor mercilessly.',
        soulProfile: {
          authoredBy: owner.publicKey,
          soul: 'Keeps the suite green and refactors mercilessly. Keep the test suite green and refactor mercilessly.',
        },
      },
    ]);

    const pictureOnlyProfile = await setAgentSoul(ctx(), communityId, agentIdentity.publicKey, {
      name: 'Ada',
      soul: 'Keeps the suite green and refactors mercilessly.',
      avatarSeed: agentIdentity.publicKey,
      avatar: 'https://relay.test/media/ada-updated.jpg',
    });
    expect(pictureOnlyProfile.soul).toBe('Keeps the suite green and refactors mercilessly.');
    expect(pictureOnlyProfile.avatar).toBe('https://relay.test/media/ada-updated.jpg');

    // An operator-chosen compound name is a legitimate persona name now; only
    // malformed values are refused.
    const compoundNameProfile = await setAgentSoul(ctx(), communityId, agentIdentity.publicKey, {
      name: 'Quiet Keeper',
      soul: 'Keeps the suite green and refactors mercilessly.',
      avatarSeed: agentIdentity.publicKey,
    });
    expect(compoundNameProfile.name).toBe('Quiet Keeper');

    agentHasHumanProfile = true;
    await expect(
      setAgentSoul(ctx(), communityId, agentIdentity.publicKey, {
        name: 'Never Human',
        soul: 'This write must not attach agent metadata to a human key.',
        avatarSeed: agentIdentity.publicKey,
      }),
    ).rejects.toThrow('already has a kind:0 profile');
  });

  it('resolves predecessor-authored souls through the current owner and picks the newest linked record deterministically', async () => {
    const predecessor = createIdentity('ox-owner-predecessor-e216a225');
    const successor = createIdentity('ox-owner-successor-5f5ad2e2');
    const unrelated = createIdentity('unrelated-soul-author');
    const oxAgent = createAgentIdentity('ox-agent-a3447f11');
    const agentRecord = signEvent(
      {
        pubkey: oxAgent.publicKey,
        created_at: 1_700_000_000,
        kind: KIND_STREAM_MESSAGE,
        tags: [
          ['h', communityId],
          ['d', 'ox-agent-id'],
          ['p', oxAgent.publicKey],
          ['name', 'Agent'],
          ['t', TAG_AGENT],
          [TAG_COMMUNITY, communityId],
        ],
        content: JSON.stringify({ displayName: 'Agent' }),
      },
      oxAgent.secretKey,
    );
    const soul = (author: typeof predecessor, createdAt: number, name: string): NostrEvent =>
      signEvent(
        {
          pubkey: author.publicKey,
          created_at: createdAt,
          kind: KIND_AGENT_SOUL,
          tags: [
            ['d', `${communityId}:${oxAgent.publicKey}`],
            ['h', communityId],
            ['p', oxAgent.publicKey],
            ['t', TAG_AGENT_SOUL],
            [TAG_COMMUNITY, communityId],
          ],
          content: JSON.stringify({
            name,
            soul: `${name} keeps ownership of prior work across daemon restarts.`,
            avatarSeed: oxAgent.publicKey,
          }),
        },
        author.secretKey,
      );
    const predecessorSoul = soul(predecessor, 1_700_000_100, 'Ox');
    const successorSoul = soul(successor, 1_700_000_200, 'Ox Current');
    const unrelatedSoul = soul(unrelated, 1_700_000_300, 'Impostor');
    let soulEvents = [predecessorSoul];
    let reverseResults = false;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const kind = (filterFrom(init).kinds as number[])[0];
        if (kind === KIND_CREATE_GROUP) return jsonResponse([communityCreate()]);
        if (kind === KIND_CHANNEL_MEMBERS) {
          return jsonResponse([
            signed(successor, KIND_CHANNEL_MEMBERS, [
              ['d', communityId],
              ['p', successor.publicKey],
              ['p', oxAgent.publicKey],
            ]),
          ]);
        }
        if (kind === KIND_CHANNEL_ADMINS) {
          return jsonResponse([
            signed(successor, KIND_CHANNEL_ADMINS, [
              ['d', communityId],
              ['p', successor.publicKey, 'owner'],
            ]),
          ]);
        }
        if (kind === KIND_STREAM_MESSAGE) return jsonResponse([agentRecord]);
        if (kind === KIND_AGENT_SOUL) {
          reverseResults = !reverseResults;
          return jsonResponse(reverseResults ? [...soulEvents].reverse() : soulEvents);
        }
        return jsonResponse([]);
      }),
    );

    const resolveCurrentPubkey = async (pubkey: string): Promise<string> =>
      pubkey === predecessor.publicKey ? successor.publicKey : pubkey;

    // Production Ox shape: the soul is signed by the e216a225 predecessor,
    // the agent is a3447f11, and the Workspace owner is now 5f5ad2e2.
    await expect(
      listAgents(ctx(successor), communityId, 200, { resolveCurrentPubkey }),
    ).resolves.toMatchObject([
      {
        pubkey: oxAgent.publicKey,
        soulProfile: { name: 'Ox', authoredBy: predecessor.publicKey },
      },
    ]);

    soulEvents = [unrelatedSoul, predecessorSoul, successorSoul];
    const firstSession = await listAgents(ctx(successor), communityId, 200, {
      resolveCurrentPubkey,
    });
    const restartedSession = await listAgents(ctx(successor), communityId, 200, {
      resolveCurrentPubkey,
    });
    expect(firstSession[0]?.soulProfile).toMatchObject({
      name: 'Ox Current',
      authoredBy: successor.publicKey,
    });
    expect(restartedSession[0]?.soulProfile).toEqual(firstSession[0]?.soulProfile);

    soulEvents = [unrelatedSoul];
    const unrelatedOnly = await listAgents(ctx(successor), communityId, 200, {
      resolveCurrentPubkey,
    });
    expect(unrelatedOnly).toMatchObject([{ pubkey: oxAgent.publicKey }]);
    expect(unrelatedOnly[0]?.soulProfile).toBeUndefined();
  });

  it('migrates legacy personality and intent into one soul without losing either text', () => {
    const legacy = signEvent(
      {
        pubkey: owner.publicKey,
        created_at: 1_700_000_000,
        kind: KIND_AGENT_SOUL,
        tags: [
          ['d', `${communityId}:${agentIdentity.publicKey}`],
          ['h', communityId],
          ['p', agentIdentity.publicKey],
          ['t', TAG_AGENT_SOUL],
          [TAG_COMMUNITY, communityId],
        ],
        content: JSON.stringify({
          name: 'Ada',
          personality: 'Keep code concise.',
          intent: 'Protect the test suite.',
          avatarSeed: agentIdentity.publicKey,
        }),
      },
      owner.secretKey,
    );

    expect(parseAgentSoul(legacy)).toMatchObject({
      soul: 'Personality: Keep code concise.\n\nIntent: Protect the test suite.',
    });
  });
});
