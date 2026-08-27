/**
 * Key-succession membership migration — the "zero re-invites" guarantee.
 *
 * A room owned (admin) by an OLD device key, with an agent member alongside,
 * must be discoverable and usable by the SUCCESSOR key after replacement:
 * `migrateSuccessorMemberships` self-joins the successor at the predecessor's
 * role, touches nobody else's membership, and skips DMs and corners.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import {
  KIND_CHANNEL_ADMINS,
  KIND_CHANNEL_MEMBERS,
  KIND_CREATE_GROUP,
  KIND_PUT_USER,
  KIND_STREAM_MESSAGE,
  TAG_AGENT,
  TAG_COMMUNITY,
  TAG_DIRECT_MESSAGE,
  TAG_PARENT,
} from './kinds.js';
import { tagValue } from './parse.js';
import { createIdentity } from './identity.js';
import { listCommunities, migrateSuccessorMemberships } from './community.js';
import {
  resetUnmigratableRooms,
  seedUnmigratableRooms,
} from './unmigratable-rooms.js';
import type { ChannelOpsContext } from './channel.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const roomId = '22222222-2222-4222-8222-222222222222';
const cornerId = '33333333-3333-4333-8333-333333333333';
const dmId = '44444444-4444-4444-8444-444444444444';

const oldKey = createIdentity('old-device-key');
const successor = createIdentity('new-device-key');
const agent = createIdentity('room-agent');

function signed(identity: typeof oldKey, kind: number, tags: string[][]): NostrEvent {
  return signEvent(
    { pubkey: identity.publicKey, created_at: 1_700_000_000, kind, tags, content: '' },
    identity.secretKey,
  );
}

function ctxFor(identity: typeof oldKey): ChannelOpsContext {
  return {
    http: { baseUrl: 'http://relay.test', host: 'relay.test', identity },
    identity,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Minimal stateful relay: membership projections per channel id, create
 * events, and kind:9000 writes that mutate projection state synchronously.
 *
 * `stuckChannels` models the measured production reality: upstream block/buzz
 * stores a kind:9000 member-add but never updates kind:39002 for rooms where
 * no living admin exists to author it — publish acks, projection frozen.
 */
function buildRelayState(
  stuckChannels: ReadonlySet<string> = new Set(),
  partialMultiKeyReads = false,
) {
  const members = new Map<string, string[][]>();
  const admins = new Map<string, string[][]>();

  // Workspace: old key is OWNER; successor absent.
  admins.set(workspaceId, [
    ['d', workspaceId],
    ['p', oldKey.publicKey, 'owner'],
  ]);
  // Room: old key ADMIN + agent member (agents' memberships stay untouched).
  admins.set(roomId, [
    ['d', roomId],
    ['p', oldKey.publicKey, 'admin'],
  ]);
  members.set(roomId, [
    ['d', roomId],
    ['p', agent.publicKey],
  ]);

  const creates = [
    signed(oldKey, KIND_CREATE_GROUP, [
      ['h', workspaceId],
      ['name', 'Personal'],
      [TAG_COMMUNITY, workspaceId],
    ]),
    signed(oldKey, KIND_CREATE_GROUP, [
      ['h', roomId],
      ['name', 'beeline'],
      [TAG_COMMUNITY, workspaceId],
    ]),
    // A corner of the Room: skipped — corners inherit their membership.
    signed(agent, KIND_CREATE_GROUP, [
      ['h', cornerId],
      ['parent', roomId],
      ['t', 'corner'],
      [TAG_COMMUNITY, workspaceId],
    ]),
    // A DM: skipped — immutable two-person Room.
    signed(oldKey, KIND_CREATE_GROUP, [['h', dmId], ['t', TAG_DIRECT_MESSAGE]]),
  ];

  function memberProjection(id: string): NostrEvent[] {
    const tags = members.get(id);
    return tags ? [signed(oldKey, KIND_CHANNEL_MEMBERS, tags)] : [];
  }
  function adminProjection(id: string): NostrEvent[] {
    const tags = admins.get(id);
    return tags ? [signed(oldKey, KIND_CHANNEL_ADMINS, tags)] : [];
  }

  return {
    published: [] as NostrEvent[],
    successorJoinedWorkspace: false,
    successorJoinedRoom: false,
    handlePublish(event: NostrEvent): void {
      this.published.push(event);
      if (event.kind !== KIND_PUT_USER) return;
      const channelId = tagValue(event, 'h');
      const target = tagValue(event, 'p');
      if (!channelId || !target) return;
      // The relay stored the write but its projection is permanently frozen.
      if (stuckChannels.has(channelId)) return;
      const roleTag = tagValue(event, 'role') ?? 'member';
      if (!channelId || !target) return;
      const entry: string[] = target === successor.publicKey
        ? roleTag === 'member'
          ? ['p', target]
          : ['p', target, '', roleTag]
        : ['p', target];
      const existing = members.get(channelId) ?? [['d', channelId]];
      existing.push(entry);
      members.set(channelId, existing);
      if (roleTag !== 'member') {
        const adminTags = admins.get(channelId) ?? [['d', channelId]];
        adminTags.push(['p', target, roleTag]);
        admins.set(channelId, adminTags);
      }
      if (channelId === workspaceId && target === successor.publicKey)
        this.successorJoinedWorkspace = true;
      if (channelId === roomId && target === successor.publicKey) this.successorJoinedRoom = true;
    },
    async query(filter: Record<string, unknown>): Promise<NostrEvent[]> {
      const kinds = (filter.kinds as number[] | undefined) ?? [];
      const authors = filter.authors as string[] | undefined;
      if (kinds.includes(KIND_STREAM_MESSAGE)) {
        // Registered-agent lookup for the successor key: not an agent.
        return [];
      }
      const pFilter = (filter['#p'] as string[] | undefined) ?? [];
      const requestedH = (filter['#h'] as string[] | undefined) ?? undefined;
      const requestedD = (filter['#d'] as string[] | undefined) ?? undefined;
      const hFilter =
        partialMultiKeyReads && requestedH && requestedH.length > 1
          ? requestedH.slice(0, 1)
          : requestedH;
      const dFilter =
        partialMultiKeyReads && requestedD && requestedD.length > 1
          ? requestedD.slice(0, 1)
          : requestedD;
      if (kinds.includes(KIND_CREATE_GROUP)) {
        return creates.filter((event) => {
          const channelId = tagValue(event, 'h') ?? '';
          if (hFilter && !hFilter.includes(channelId)) return false;
          if (dFilter && !dFilter.includes(channelId)) return false;
          return true;
        });
      }
      if (kinds.includes(KIND_PUT_USER)) {
        return this.published.filter((event) => {
          if (event.kind !== KIND_PUT_USER) return false;
          if (hFilter && !hFilter.includes(tagValue(event, 'h') ?? '')) return false;
          return pFilter.length === 0 || pFilter.includes(tagValue(event, 'p') ?? '');
        });
      }
      // Projection reads are scoped by #d (primary) or #h (fallback); an
      // unscoped discovery read unions every known channel.
      const scopedIds = dFilter ?? hFilter;
      const matchingChannelIds = (scopedIds ?? [...new Set([...members.keys(), ...admins.keys()])])
        .filter((id) => {
          if (pFilter.length === 0) return true;
          const named = (tags: string[][] | undefined) =>
            (tags ?? []).some((tag) => tag[0] === 'p' && pFilter.includes(tag[1] ?? ''));
          return named(members.get(id)) || named(admins.get(id));
        });
      const result: NostrEvent[] = [];
      for (const id of matchingChannelIds) {
        if (kinds.includes(KIND_CHANNEL_MEMBERS)) result.push(...memberProjection(id));
        if (kinds.includes(KIND_CHANNEL_ADMINS)) result.push(...adminProjection(id));
      }
      return result;
    },
  };
}

let relay: ReturnType<typeof buildRelayState>;

async function queryRelayBatch(filters: readonly Record<string, unknown>[]): Promise<NostrEvent[]> {
  const events = (await Promise.all(filters.map((filter) => relay.query(filter)))).flat();
  return [...new Map(events.map((event) => [event.id, event])).values()];
}

beforeEach(() => {
  // Verdicts are session-scoped by design; each test starts clean.
  resetUnmigratableRooms();
});

function stubRelayFetch(options?: { publishStatusFor?: (event: NostrEvent) => number }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/events')) {
        const event = JSON.parse(String(init?.body)) as NostrEvent;
        const status = options?.publishStatusFor?.(event);
        if (status && status !== 200) return new Response('rejected', { status });
        relay.handlePublish(event);
        return jsonResponse({ accepted: true });
      }
      if (url.endsWith('/query')) {
        return jsonResponse(
          await queryRelayBatch(JSON.parse(String(init?.body)) as Record<string, unknown>[]),
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('key-succession membership migration', () => {
  it('joins the successor into the predecessor\u2019s workspace and rooms at their roles with zero re-invites', async () => {
    relay = buildRelayState();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const body = String(init?.body ?? '');
        if (url.endsWith('/events')) {
          relay.handlePublish(JSON.parse(body) as NostrEvent);
          return jsonResponse({ accepted: true });
        }
        if (url.endsWith('/query')) {
          const filters = JSON.parse(body) as Record<string, unknown>[];
          return jsonResponse(await queryRelayBatch(filters));
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    // Discovery BEFORE migration: nothing names the successor yet.
    await expect(listCommunities(ctxFor(successor), successor.publicKey)).resolves.toEqual([]);

    // Migration walks the chain and self-joins at the predecessor's roles.
    const migrated = await migrateSuccessorMemberships(ctxFor(successor), [oldKey.publicKey]);
    expect(migrated.sort()).toEqual([roomId, workspaceId].sort());

    // Workspace owner + room admin authority followed the account…
    expect(relay.successorJoinedWorkspace).toBe(true);
    expect(relay.successorJoinedRoom).toBe(true);

    // …the agent member was untouched (only ever #p = successor written).
    const successorWrites = relay.published.filter(
      (event) => event.kind === KIND_PUT_USER && tagValue(event, 'p') === successor.publicKey,
    );
    expect(successorWrites).toHaveLength(2);
    expect(
      relay.published.filter(
        (event) => event.kind === KIND_PUT_USER && tagValue(event, 'p') === agent.publicKey,
      ),
    ).toHaveLength(0);

    // …and discovery now lists the workspace for the successor.
    const communities = await listCommunities(ctxFor(successor), successor.publicKey);
    expect(communities.map((community) => community.communityId)).toContain(workspaceId);
    expect(communities.find((c) => c.communityId === workspaceId)?.viewerRole).toBe('owner');
  });

  it('classifies every successor target when multi-key #h filters answer partially', async () => {
    relay = buildRelayState(new Set(), true);
    stubRelayFetch();

    await expect(
      migrateSuccessorMemberships(ctxFor(successor), [oldKey.publicKey]),
    ).resolves.toEqual(expect.arrayContaining([workspaceId, roomId]));
    expect(relay.successorJoinedWorkspace).toBe(true);
    expect(relay.successorJoinedRoom).toBe(true);
  });

  it('is idempotent: already-migrated channels are not rewritten', async () => {
    relay = buildRelayState();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/events')) {
          relay.handlePublish(JSON.parse(String(init?.body)) as NostrEvent);
          return jsonResponse({ accepted: true });
        }
        if (url.endsWith('/query')) {
          return jsonResponse(
            await queryRelayBatch(JSON.parse(String(init?.body)) as Record<string, unknown>[]),
          );
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );

    await migrateSuccessorMemberships(ctxFor(successor), [oldKey.publicKey]);
    const writesAfterFirstPass = relay.published.length;
    await migrateSuccessorMemberships(ctxFor(successor), [oldKey.publicKey]);
    expect(relay.published.length).toBe(writesAfterFirstPass);
  });

  it('skips a room the relay never projects as NOT MIGRATABLE and still migrates the rest', async () => {
    // Production reality 2026-08-23: the room's only admin was the
    // predecessor, so the relay stores the successor's self-join but its
    // kind:39002 projection never updates. Migration must not throw.
    relay = buildRelayState(new Set([roomId]));
    stubRelayFetch();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const migrated = await migrateSuccessorMemberships(ctxFor(successor), [
        oldKey.publicKey,
      ], { membershipWaitTimeoutMs: 50 });
      // The workspace joined; the orphaned room is skipped, not fatal.
      expect(migrated).toEqual([workspaceId]);
      expect(relay.successorJoinedWorkspace).toBe(true);
      expect(relay.successorJoinedRoom).toBe(false);

      // Exactly one log line names the skipped room.
      const lines = warn.mock.calls
        .map((call) => call.join(' '))
        .filter((line) => line.includes(roomId));
      expect(lines).toHaveLength(1);

      // The verdict is cached for the session: a repeat bootstrap re-skips
      // the orphaned room WITHOUT re-asserting the projection wait — no new
      // join attempt for that room at all.
      const publishedAfterFirstPass = relay.published.length;
      const second = await migrateSuccessorMemberships(ctxFor(successor), [
        oldKey.publicKey,
      ],
      { membershipWaitTimeoutMs: 50 });
      expect(second).toEqual([]);
      expect(relay.published.length).toBe(publishedAfterFirstPass);
      expect(
        warn.mock.calls.map((call) => call.join(' ')).filter((line) => line.includes(roomId)),
      ).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('reuses a seeded unmigratable verdict without waiting on first bootstrap', async () => {
    seedUnmigratableRooms([{ channelId: roomId, pubkey: successor.publicKey }]);
    relay = buildRelayState(new Set([roomId]));
    stubRelayFetch();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const start = Date.now();
      const migrated = await migrateSuccessorMemberships(ctxFor(successor), [
        oldKey.publicKey,
      ]);
      expect(migrated).toEqual([workspaceId]);
      // Seeded skip: no 15s projection wait, not even a short one.
      expect(Date.now() - start).toBeLessThan(2_000);
      // No re-log for a verdict learned on an earlier launch.
      expect(warn.mock.calls.map((call) => call.join(' '))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('still errors on a genuine relay rejection of the join write', async () => {
    relay = buildRelayState();
    stubRelayFetch({
      // HTTP 400 is non-retryable in publishEvent: fails fast.
      publishStatusFor: (event) =>
        event.kind === KIND_PUT_USER && tagValue(event, 'h') === workspaceId ? 400 : 200,
    });
    await expect(
      migrateSuccessorMemberships(ctxFor(successor), [oldKey.publicKey]),
    ).rejects.toMatchObject({ kind: 'INVALID_EVENT', retryable: false });
  });
});
