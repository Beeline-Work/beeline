import { afterEach, describe, expect, it, vi } from 'vitest';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import {
  getRoomRepository,
  parseRoomRepository,
  readRoomRepositoryConfig,
  resolveRoomRepository,
  resolveRoomRepositoryState,
  setRoomRepository,
  setRoomTargetBranch,
  setRoomGitHubEvents,
  normalizeTargetBranchName,
} from './room-repository.js';
import { createIdentity } from './identity.js';
import {
  KIND_CHANNEL_ADMINS,
  KIND_CHANNEL_MEMBERS,
  KIND_CREATE_GROUP,
  KIND_ROOM_REPOSITORY,
  TAG_COMMUNITY,
  TAG_ROOM_REPOSITORY,
} from './kinds.js';
import type { ChannelOpsContext } from './channel.js';

const communityId = '11111111-1111-4111-8111-111111111111';
const channelId = '22222222-2222-4222-8222-222222222222';
const admin = createIdentity('room-admin');
const roomAdmin = createIdentity('room-non-owner-admin');
const member = createIdentity('room-member');
const http = { baseUrl: 'http://relay.test', host: 'relay.test' };

function ctx(identity = admin): ChannelOpsContext {
  return { http: { ...http, identity }, identity };
}

function signed(identity: typeof admin, kind: number, tags: string[][], content = ''): NostrEvent {
  return signEvent(
    { pubkey: identity.publicKey, created_at: Math.floor(Date.now() / 1000), kind, tags, content },
    identity.secretKey,
  );
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

/** The Room's immutable create event, optionally carrying the genesis binding. */
function roomCreate(withGenesisRepo: boolean): NostrEvent {
  const tags: string[][] = [
    ['h', channelId],
    ['name', 'buzzy'],
    [TAG_COMMUNITY, communityId],
  ];
  if (withGenesisRepo) {
    tags.push(['repo-key', 'genesis-key'], ['repo-name', 'buzzy'], ['repo-scope', 'remote']);
    tags.push(['repo-remote', 'git://github.com/lunchboxfortwo/buzzy']);
  }
  return signed(admin, KIND_CREATE_GROUP, tags);
}

/**
 * Minimal relay stub. `#p`-scoped admin membership is honoured so a reader-side
 * `getChannelRole` distinguishes the admin from a plain member.
 */
function stubRelay(opts: {
  published: NostrEvent[];
  genesisRepo?: boolean;
  admins?: string[];
  members?: string[];
}): void {
  const admins = opts.admins ?? [admin.publicKey];
  const members = opts.members ?? [admin.publicKey, member.publicKey];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/events')) {
        opts.published.push(JSON.parse(String(init?.body)) as NostrEvent);
        return jsonResponse({ accepted: true });
      }
      const filter = filterFrom(init);
      const kind = (filter.kinds as number[])[0];
      if (kind === KIND_CREATE_GROUP) return jsonResponse([roomCreate(opts.genesisRepo ?? false)]);
      if (kind === KIND_CHANNEL_ADMINS) {
        return jsonResponse([
          signed(admin, KIND_CHANNEL_ADMINS, [
            ['d', channelId],
            ...admins.map((pk) => ['p', pk, '', pk === admin.publicKey ? 'owner' : 'admin']),
          ]),
        ]);
      }
      if (kind === KIND_CHANNEL_MEMBERS) {
        return jsonResponse([
          signed(admin, KIND_CHANNEL_MEMBERS, [
            ['d', channelId],
            ...members.map((pk) => ['p', pk]),
          ]),
        ]);
      }
      if (kind === KIND_ROOM_REPOSITORY) {
        const d = (filter['#d'] as string[] | undefined)?.[0];
        return jsonResponse(
          opts.published.filter(
            (event) =>
              event.kind === KIND_ROOM_REPOSITORY &&
              (!d || event.tags.some((tag) => tag[0] === 'd' && tag[1] === d)),
          ),
        );
      }
      return jsonResponse([]);
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('room repository binding', () => {
  it('round-trips an admin-authored binding and rejects a non-admin author', async () => {
    const published: NostrEvent[] = [];
    stubRelay({ published });

    const bound = await setRoomRepository(ctx(admin), channelId, {
      key: 'repo-key',
      name: 'buzzy',
      remote: 'git://github.com/lunchboxfortwo/buzzy',
      targetBranch: 'main',
    });
    expect(bound.raw!.pubkey).toBe(admin.publicKey);
    expect(bound.raw!.kind).toBe(KIND_ROOM_REPOSITORY);
    expect(bound.raw!.tags).toContainEqual(['t', TAG_ROOM_REPOSITORY]);
    expect(bound.source).toBe('config');
    expect(bound.binding).toMatchObject({
      key: 'repo-key',
      remote: 'git://github.com/lunchboxfortwo/buzzy',
      localOnly: false,
    });
    expect(bound.targetBranch).toBe('main');

    await expect(getRoomRepository(ctx(admin), channelId)).resolves.toMatchObject({
      source: 'config',
      authoredBy: admin.publicKey,
    });

    await expect(
      setRoomRepository(ctx(member), channelId, {
        key: 'repo-key',
        name: 'buzzy',
        remote: 'git://github.com/lunchboxfortwo/buzzy',
      }),
    ).rejects.toThrow('only a Room admin');
  });

  it('refuses a registered agent identity even when it holds the admin role', async () => {
    // Repo binding is a HUMAN decision. The admin-role check alone cannot
    // enforce that — an operator can grant an agent admin — so the durable
    // self-signed agent registry refuses the key regardless of role.
    const agent = createIdentity('agent-admin');
    const published: NostrEvent[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/events')) {
          published.push(JSON.parse(String(init?.body)) as NostrEvent);
          return jsonResponse({ accepted: true });
        }
        const filter = filterFrom(init);
        if ((filter.kinds as number[])[0] === 9) {
          const authors = (filter.authors as string[]) ?? [];
          return jsonResponse(
            authors.includes(agent.publicKey)
              ? [
                  signed(agent, 9, [
                    ['t', 'buzz-agent'],
                    ['h', communityId],
                    ['community', communityId],
                    ['d', 'agent-record'],
                    ['p', agent.publicKey],
                  ]),
                ]
              : [],
          );
        }
        if ((filter.kinds as number[])[0] === KIND_CHANNEL_ADMINS) {
          return jsonResponse([
            signed(admin, KIND_CHANNEL_ADMINS, [
              ['d', channelId],
              ['p', admin.publicKey, '', 'admin'],
              ['p', agent.publicKey, '', 'admin'],
            ]),
          ]);
        }
        if ((filter.kinds as number[])[0] === KIND_CHANNEL_MEMBERS) {
          return jsonResponse([
            signed(admin, KIND_CHANNEL_MEMBERS, [
              ['d', channelId],
              ['p', admin.publicKey],
              ['p', agent.publicKey],
            ]),
          ]);
        }
        return jsonResponse([]);
      }),
    );

    await expect(
      setRoomRepository(ctx(agent), channelId, {
        key: 'repo-key',
        name: 'buzzy',
        remote: 'git://github.com/lunchboxfortwo/buzzy',
      }),
    ).rejects.toThrow('human action');
    expect(published).toEqual([]);
  });

  it('rejects a local-only binding with no remote', async () => {
    const published: NostrEvent[] = [];
    stubRelay({ published });
    await expect(
      setRoomRepository(ctx(admin), channelId, { key: 'k', name: 'n', remote: '   ' }),
    ).rejects.toThrow('git remote URL');
  });

  it('ignores a config event whose author is no longer a Room admin', async () => {
    const published: NostrEvent[] = [];
    // The member is NOT in the admin projection, so a binding they authored is
    // ignored on read even though it is the newest event on the wire.
    stubRelay({ published, admins: [admin.publicKey] });

    published.push(
      signEvent(
        {
          pubkey: member.publicKey,
          created_at: Math.floor(Date.now() / 1000) + 100,
          kind: KIND_ROOM_REPOSITORY,
          tags: [
            ['d', `${TAG_ROOM_REPOSITORY}:${channelId}`],
            ['h', channelId],
            ['t', TAG_ROOM_REPOSITORY],
            [TAG_COMMUNITY, communityId],
          ],
          content: JSON.stringify({
            key: 'evil',
            name: 'evil',
            remote: 'git://evil.example/x',
            localOnly: false,
          }),
        },
        member.secretKey,
      ),
    );

    await expect(getRoomRepository(ctx(admin), channelId)).resolves.toBeNull();
  });

  it('parseRoomRepository rejects a binding with no remote', () => {
    const event = signEvent(
      {
        pubkey: admin.publicKey,
        created_at: 1,
        kind: KIND_ROOM_REPOSITORY,
        tags: [
          ['d', `${TAG_ROOM_REPOSITORY}:${channelId}`],
          ['h', channelId],
          ['t', TAG_ROOM_REPOSITORY],
        ],
        content: JSON.stringify({ key: 'k', name: 'n', localOnly: true }),
      },
      admin.secretKey,
    );
    expect(parseRoomRepository(event)).toBeNull();
  });
});

describe('resolveRoomRepository', () => {
  it('resolves a room with a repo for corner-open (config path)', async () => {
    const published: NostrEvent[] = [];
    stubRelay({ published });
    await setRoomRepository(ctx(admin), channelId, {
      key: 'repo-key',
      name: 'buzzy',
      remote: 'git://github.com/lunchboxfortwo/buzzy',
    });
    const resolved = await resolveRoomRepository(ctx(admin), channelId);
    expect(resolved).toMatchObject({ source: 'config', binding: { key: 'repo-key' } });
  });

  it('migrates a per-agent binding via the genesis create-event fallback', async () => {
    const published: NostrEvent[] = [];
    // No config event published; the Room only carries its immutable genesis
    // binding (the shape every pre-room-repo Room has). Resolution still works.
    stubRelay({ published, genesisRepo: true });
    const resolved = await resolveRoomRepository(ctx(admin), channelId);
    expect(resolved).toMatchObject({
      source: 'genesis',
      binding: {
        key: 'genesis-key',
        remote: 'git://github.com/lunchboxfortwo/buzzy',
        localOnly: false,
      },
    });
  });

  it('returns null for a chat-only room with no repository', async () => {
    const published: NostrEvent[] = [];
    stubRelay({ published, genesisRepo: false });
    await expect(resolveRoomRepository(ctx(admin), channelId)).resolves.toBeNull();
  });
});

/**
 * "We could not confirm it" and "there isn't one" were the same answer — the
 * same `null` — and they are not the same fact. The admin projection is a
 * separate relay read, and one that comes back empty under load used to tell an
 * admin their configured Room had no repository, and (worse) let the supervisor
 * reclassify a live repository Room as a repo-less one mid-session.
 */
describe('a repository that cannot be confirmed is not a repository that is absent', () => {
  it('reports `none` only when the Room really has no repository anywhere', async () => {
    const published: NostrEvent[] = [];
    stubRelay({ published, genesisRepo: false });
    await expect(resolveRoomRepositoryState(ctx(admin), channelId)).resolves.toEqual({
      kind: 'none',
    });
  });

  it('reports `unverified`, not `none`, when the config author no longer reads as an admin', async () => {
    const published: NostrEvent[] = [];
    stubRelay({ published });
    await setRoomRepository(ctx(admin), channelId, {
      key: 'repo-key',
      name: 'buzzy',
      remote: 'git://github.com/lunchboxfortwo/buzzy',
    });
    // The admin projection comes back without the author — a transient empty
    // read is indistinguishable from a demotion, and both land here.
    stubRelay({ published, admins: [], genesisRepo: false });

    const state = await resolveRoomRepositoryState(ctx(admin), channelId);
    expect(state.kind).toBe('unverified');
    expect(state.kind === 'unverified' && state.reason).toContain('repository configuration event');
    // And the compat reader still refuses it — the admin check is the whole
    // authority model and is not relaxed by reporting the uncertainty.
    await expect(getRoomRepository(ctx(admin), channelId)).resolves.toBeNull();
  });

  it('still resolves through the genesis binding when the config is unverified', async () => {
    const published: NostrEvent[] = [];
    stubRelay({ published });
    await setRoomRepository(ctx(admin), channelId, {
      key: 'repo-key',
      name: 'buzzy',
      remote: 'git://github.com/lunchboxfortwo/buzzy',
    });
    stubRelay({ published, admins: [], genesisRepo: true });

    // An immutable repository named on the Room's own create event is a fact
    // no role projection can invalidate.
    await expect(resolveRoomRepositoryState(ctx(admin), channelId)).resolves.toMatchObject({
      kind: 'repository',
      repository: { source: 'genesis' },
    });
  });

  it('separates the config read from the genesis fallback', async () => {
    const published: NostrEvent[] = [];
    stubRelay({ published, genesisRepo: true });
    // `readRoomRepositoryConfig` speaks only for the mutable config, so a Room
    // carrying only its genesis binding is `none` there and `repository` after
    // the fallback.
    await expect(readRoomRepositoryConfig(ctx(admin), channelId)).resolves.toEqual({
      kind: 'none',
    });
    await expect(resolveRoomRepositoryState(ctx(admin), channelId)).resolves.toMatchObject({
      kind: 'repository',
    });
  });
});

/**
 * Key succession: a Room's binding may have been authored by the owner's
 * PREDECESSOR device key — after a replacement that key no longer reads back
 * as a Room admin, so resolution used to report `unverified` and the auth
 * service's room-token path aborted with `room_repository_missing` before its
 * own succession-aware authority check ever ran (production, 2026-08-23).
 * Readers that CAN resolve the chain thread a resolver in and the author
 * authorizes through its CURRENT key; everyone else keeps today's behavior.
 */
describe('binding author resolves through the owner succession chain', () => {
  const predecessor = createIdentity('owner-predecessor');
  const successor = createIdentity('owner-successor');
  const stranger = createIdentity('stranger');

  function bindingAuthoredBy(identity: typeof predecessor): NostrEvent {
    return signEvent(
      {
        pubkey: identity.publicKey,
        created_at: Math.floor(Date.now() / 1000),
        kind: KIND_ROOM_REPOSITORY,
        tags: [
          ['d', `${TAG_ROOM_REPOSITORY}:${channelId}`],
          ['h', channelId],
          ['t', TAG_ROOM_REPOSITORY],
          [TAG_COMMUNITY, communityId],
        ],
        content: JSON.stringify({
          key: 'repo-key',
          name: 'buzzy',
          remote: 'git://github.com/lunchboxfortwo/buzzy',
          localOnly: false,
        }),
      },
      identity.secretKey,
    );
  }

  // The successor holds the Room owner role; the predecessor key was removed
  // from the projections when the device key was replaced.
  function stubSuccessionRoom(published: NostrEvent[]): void {
    stubRelay({
      published,
      admins: [successor.publicKey],
      members: [successor.publicKey],
      genesisRepo: false,
    });
  }

  const resolver = {
    resolveCurrentPubkey: async (pubkey: string): Promise<string> =>
      pubkey === predecessor.publicKey ? successor.publicKey : pubkey,
  };

  it('resolves a predecessor-authored binding through the current owner key', async () => {
    stubSuccessionRoom([bindingAuthoredBy(predecessor)]);

    await expect(resolveRoomRepository(ctx(successor), channelId, resolver)).resolves.toMatchObject(
      { source: 'config', authoredBy: predecessor.publicKey },
    );
    await expect(resolveRoomRepositoryState(ctx(successor), channelId, resolver)).resolves.toEqual({
      kind: 'repository',
      repository: expect.objectContaining({ authoredBy: predecessor.publicKey }),
    });
  });

  it('keeps today’s `unverified` answer when no resolver is supplied', async () => {
    // Same wire state, but this reader cannot resolve the chain — behavior is
    // exactly pre-succession: never a silent widening.
    stubSuccessionRoom([bindingAuthoredBy(predecessor)]);

    await expect(resolveRoomRepositoryState(ctx(successor), channelId)).resolves.toMatchObject({
      kind: 'unverified',
    });
    await expect(resolveRoomRepository(ctx(successor), channelId)).resolves.toBeNull();
  });

  it('degrades to the raw-author check when the chain cannot be resolved', async () => {
    stubSuccessionRoom([bindingAuthoredBy(predecessor)]);

    await expect(
      resolveRoomRepository(ctx(successor), channelId, {
        resolveCurrentPubkey: async () => {
          throw new Error('ledger unavailable');
        },
      }),
    ).resolves.toBeNull();
  });

  it('refuses a binding authored by an unrelated key even with the resolver', async () => {
    stubSuccessionRoom([bindingAuthoredBy(stranger)]);

    // The stranger resolves to itself; it holds no Room role.
    await expect(
      resolveRoomRepositoryState(ctx(successor), channelId, resolver),
    ).resolves.toMatchObject({
      kind: 'unverified',
    });
    await expect(resolveRoomRepository(ctx(successor), channelId, resolver)).resolves.toBeNull();
  });
});

describe('room target branch (chat-native change)', () => {
  it('normalizes a proposed branch name and refuses anything that is not one', () => {
    expect(normalizeTargetBranchName(' staging ')).toBe('staging');
    expect(normalizeTargetBranchName('refs/heads/release/2026-08')).toBe('release/2026-08');
    for (const bad of [
      '',
      '   ',
      'two words',
      'a..b',
      'a\\b',
      '-lead',
      'x.lock',
      '@',
      'a//b',
      '.hidden',
    ]) {
      expect(normalizeTargetBranchName(bad)).toBeNull();
    }
  });

  it('republishes the SAME binding under the confirming owner key with the new target', async () => {
    const published: NostrEvent[] = [];
    stubRelay({ published });
    await setRoomRepository(ctx(admin), channelId, {
      key: 'repo-key',
      name: 'buzzy',
      remote: 'git://github.com/lunchboxfortwo/buzzy',
      targetBranch: 'main',
    });

    const updated = await setRoomTargetBranch(ctx(admin), channelId, 'refs/heads/staging');
    expect(updated.targetBranch).toBe('staging');
    // Binding identity is carried forward untouched — only the target moved.
    expect(updated.binding).toMatchObject({
      key: 'repo-key',
      name: 'buzzy',
      remote: 'git://github.com/lunchboxfortwo/buzzy',
    });
    expect(updated.raw!.pubkey).toBe(admin.publicKey);
    expect(updated.raw!.tags).toContainEqual(['action', 'switch-target-branch']);
    await expect(getRoomRepository(ctx(admin), channelId)).resolves.toMatchObject({
      targetBranch: 'staging',
      authoredBy: admin.publicKey,
    });
  });

  it('promotes a genesis-bound Room to a config binding without inventing a remote', async () => {
    const published: NostrEvent[] = [];
    stubRelay({ published, genesisRepo: true });
    const updated = await setRoomTargetBranch(ctx(admin), channelId, 'staging');
    expect(updated.source).toBe('config');
    expect(updated.binding.remote).toBe('git://github.com/lunchboxfortwo/buzzy');
    expect(updated.binding.key).toBe('genesis-key');
    expect(updated.targetBranch).toBe('staging');
  });

  it('refuses a non-owner member, and the reader ignores the event even if it lands', async () => {
    const published: NostrEvent[] = [];
    stubRelay({ published, genesisRepo: true, admins: [admin.publicKey] });

    // Client-side: the SDK refuses to author it at all.
    await expect(setRoomTargetBranch(ctx(member), channelId, 'staging')).rejects.toThrow(
      'only the Room owner',
    );
    expect(published).toHaveLength(0);

    // Reader-side: even a hand-signed non-admin event on the wire is ignored.
    published.push(
      signEvent(
        {
          pubkey: member.publicKey,
          created_at: Math.floor(Date.now() / 1000) + 500,
          kind: KIND_ROOM_REPOSITORY,
          tags: [
            ['d', `${TAG_ROOM_REPOSITORY}:${channelId}`],
            ['h', channelId],
            ['t', TAG_ROOM_REPOSITORY],
          ],
          content: JSON.stringify({
            key: 'genesis-key',
            name: 'buzzy',
            remote: 'git://github.com/lunchboxfortwo/buzzy',
            localOnly: false,
            targetBranch: 'staging',
          }),
        },
        member.secretKey,
      ),
    );
    await expect(getRoomRepository(ctx(admin), channelId)).resolves.toBeNull();
  });

  it('refuses a Room admin who is not the owner on both write and read', async () => {
    const published: NostrEvent[] = [];
    stubRelay({
      published,
      genesisRepo: true,
      admins: [admin.publicKey, roomAdmin.publicKey],
      members: [admin.publicKey, roomAdmin.publicKey],
    });

    await expect(setRoomTargetBranch(ctx(roomAdmin), channelId, 'staging')).rejects.toThrow(
      'only the Room owner',
    );
    await expect(
      setRoomRepository(ctx(roomAdmin), channelId, {
        key: 'genesis-key',
        name: 'buzzy',
        remote: 'git://github.com/lunchboxfortwo/buzzy',
        targetBranch: 'staging',
      }),
    ).rejects.toThrow('only the Room owner');
    expect(published).toHaveLength(0);

    published.push(
      signEvent(
        {
          pubkey: roomAdmin.publicKey,
          created_at: Math.floor(Date.now() / 1000) + 500,
          kind: KIND_ROOM_REPOSITORY,
          tags: [
            ['d', `${TAG_ROOM_REPOSITORY}:${channelId}`],
            ['h', channelId],
            ['t', TAG_ROOM_REPOSITORY],
            ['action', 'switch-target-branch'],
          ],
          content: JSON.stringify({
            key: 'genesis-key',
            name: 'buzzy',
            remote: 'git://github.com/lunchboxfortwo/buzzy',
            localOnly: false,
            targetBranch: 'staging',
          }),
        },
        roomAdmin.secretKey,
      ),
    );
    // Omitting the action marker is not a bypass: the reader compares the
    // target to the prior same-repository binding and still requires owner.
    published.push(
      signEvent(
        {
          pubkey: roomAdmin.publicKey,
          created_at: Math.floor(Date.now() / 1000) + 501,
          kind: KIND_ROOM_REPOSITORY,
          tags: [
            ['d', `${TAG_ROOM_REPOSITORY}:${channelId}`],
            ['h', channelId],
            ['t', TAG_ROOM_REPOSITORY],
          ],
          content: JSON.stringify({
            key: 'genesis-key',
            name: 'buzzy',
            remote: 'git://github.com/lunchboxfortwo/buzzy',
            localOnly: false,
            targetBranch: 'staging',
          }),
        },
        roomAdmin.secretKey,
      ),
    );
    await expect(getRoomRepository(ctx(admin), channelId)).resolves.toBeNull();
  });

  it('refuses an invalid branch name and a Room with no repository', async () => {
    const published: NostrEvent[] = [];
    stubRelay({ published, genesisRepo: true });
    await expect(setRoomTargetBranch(ctx(admin), channelId, 'two words')).rejects.toThrow(
      'not a valid git branch name',
    );

    stubRelay({ published: [], genesisRepo: false });
    await expect(setRoomTargetBranch(ctx(admin), channelId, 'staging')).rejects.toThrow(
      'no repository linked',
    );
  });
});

describe('per-Room GitHub activity toggle', () => {
  it('round-trips through the room-config record and carries the binding forward', async () => {
    const published: NostrEvent[] = [];
    stubRelay({ published });
    await setRoomRepository(ctx(admin), channelId, {
      key: 'repo-key',
      name: 'buzzy',
      remote: 'git://github.com/lunchboxfortwo/buzzy',
      targetBranch: 'main',
    });

    // Absent flag reads as enabled (default ON).
    const initial = await getRoomRepository(ctx(admin), channelId);
    expect(initial!.githubEventsEnabled).toBeUndefined();

    const updated = await setRoomGitHubEvents(ctx(admin), channelId, false);
    expect(updated.githubEventsEnabled).toBe(false);
    // Binding identity and target branch carried forward untouched.
    expect(updated.binding).toMatchObject({
      key: 'repo-key',
      remote: 'git://github.com/lunchboxfortwo/buzzy',
    });
    expect(updated.targetBranch).toBe('main');
    await expect(getRoomRepository(ctx(admin), channelId)).resolves.toMatchObject({
      githubEventsEnabled: false,
    });

    const reenabled = await setRoomGitHubEvents(ctx(admin), channelId, true);
    expect(reenabled.githubEventsEnabled).toBe(true);
  });

  it('refuses a non-admin writer', async () => {
    const published: NostrEvent[] = [];
    stubRelay({ published, genesisRepo: true, admins: [admin.publicKey] });
    await expect(setRoomGitHubEvents(ctx(member), channelId, false)).rejects.toThrow(
      'only a Room admin',
    );
    expect(published).toHaveLength(0);
  });

  it('promotes a genesis-bound Room to a config event when toggling', async () => {
    const published: NostrEvent[] = [];
    stubRelay({ published, genesisRepo: true });
    const updated = await setRoomGitHubEvents(ctx(admin), channelId, false);
    expect(updated.source).toBe('config');
    expect(updated.binding.key).toBe('genesis-key');
    expect(updated.githubEventsEnabled).toBe(false);
  });

  it('refuses to toggle when the Room has no repository at all', async () => {
    const published: NostrEvent[] = [];
    stubRelay({ published });
    await expect(setRoomGitHubEvents(ctx(admin), channelId, false)).rejects.toThrow(
      /no repository linked/,
    );
  });
});
