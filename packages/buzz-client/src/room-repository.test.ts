import { afterEach, describe, expect, it, vi } from 'vitest';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import {
  parseRoomRepository,
  readRoomRepositoryConfig,
  resolveRoomRepository,
  resolveRoomRepositoryState,
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
});
