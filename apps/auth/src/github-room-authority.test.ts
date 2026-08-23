import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { PGlite, type PGliteInterface, type Transaction } from '@electric-sql/pglite';
import { generateKeypair, signEvent, type NostrEvent } from '@beeline/nostr';

// Only the creator fallback is mocked: everything else runs the REAL
// buzz-client resolution against a fetch-stubbed relay, because this file's
// whole point is that binding RESOLUTION — not just the checks around it —
// follows the owner's succession chain.
const relay = vi.hoisted(() => ({
  getChannelCreator: vi.fn(),
}));

vi.mock('@beeline/buzz-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@beeline/buzz-client')>();
  return { ...actual, getChannelCreator: relay.getChannelCreator };
});

import { createGitHubRoomTokenAuthority } from './github-room-authority.js';
import { AuthStore, type TransactionalDatabase } from './store.js';
import type { AuthTenant } from './server.js';

// Captured read-only from production on 2026-08-21. The relay hosts both SQL
// communities, while this Room's client-authored kind:9007 `community` tag is
// a6814772-1f7f-4a59-850b-5579039efb17 and is deliberately not an authority.
const legacyRelayCommunityId = '3a47eeff-fdff-4a1e-9eb9-b48cb4ed90ed';
const roomCommunityId = 'e8299f28-f095-472f-941a-80d1195b9a24';
const roomId = '484556f2-7e81-4ad6-a851-0e57bdba6a67';

// Wire constants mirrored from packages/buzz-client kinds.ts (not exported
// from the package root).
const KIND_ROOM_REPOSITORY = 30078;
const KIND_CREATE_GROUP = 9007;
const KIND_CHANNEL_ADMINS = 39001;
const KIND_CHANNEL_MEMBERS = 39002;

const agent = generateKeypair();
const ownerPredecessor = generateKeypair();
const ownerSuccessor = generateKeypair();
const stranger = generateKeypair();

const tenant: AuthTenant = {
  host: 'relay.example',
  // This is deliberately not the Room UUID: production keeps its legacy
  // hostname here so identity links survive the public-host migration.
  community: 'legacy.relay.example',
  roomCommunityIds: [legacyRelayCommunityId, roomCommunityId],
  origin: 'https://relay.example',
};
const input = {
  agentPubkey: agent.publicKey,
  roomId,
  relayAuthorizations: Array.from({ length: 16 }, (_, index) => `proof-${index}`),
};

let pglite: PGlite;
let database: PgliteDatabase;
let store: AuthStore;
let relayEvents: NostrEvent[];

/** Minimal `TransactionalDatabase` over PGlite — the same shape server.test.ts uses. */
class PgliteDatabase implements TransactionalDatabase {
  constructor(readonly client: PGliteInterface) {}

  async query<Row extends Record<string, unknown>>(
    sql: string,
    values: unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number | null }> {
    const result = await this.client.query<Row>(sql, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
  }

  async transaction<T>(work: (tx: Transaction & { query: unknown }) => Promise<T>): Promise<T> {
    return this.client.transaction(async (transaction: Transaction) =>
      work(
        Object.assign(transaction, {
          query: async <Row extends Record<string, unknown>>(sql: string, values: unknown[] = []) => {
            const result = await transaction.query<Row>(sql, values);
            return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
          },
        }),
      ),
    );
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function eventMatchesFilter(event: NostrEvent, filter: Record<string, unknown>): boolean {
  if (Array.isArray(filter.kinds) && !filter.kinds.includes(event.kind)) return false;
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith('#')) continue;
    if (!Array.isArray(values)) continue;
    if (!event.tags.some((tag) => tag[0] === key.slice(1) && values.includes(tag[1]))) return false;
  }
  return true;
}

/**
 * Minimal relay stub answering `/query` with the union of every stubbed event
 * matching any filter in the request body — the client partitions batched
 * multi-filter requests itself (`selectQueryEvents`).
 */
function stubRelayQuery(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const filters = JSON.parse(String(init?.body)) as Record<string, unknown>[];
      const matching = relayEvents.filter((event) =>
        filters.some((filter) => eventMatchesFilter(event, filter)),
      );
      return jsonResponse(matching);
    }),
  );
}

function signed(keypair: typeof agent, kind: number, tags: string[][], content = ''): NostrEvent {
  return signEvent(
    { pubkey: keypair.publicKey, created_at: Math.floor(Date.now() / 1000), kind, tags, content },
    keypair.secretKey,
  );
}

function adminsProjection(...pubkeys: string[]): NostrEvent {
  return signed(ownerSuccessor, KIND_CHANNEL_ADMINS, [
    ['d', roomId],
    ...pubkeys.map((pk) => ['p', pk, '', 'owner']),
  ]);
}

function membersProjection(...pubkeys: string[]): NostrEvent {
  return signed(ownerSuccessor, KIND_CHANNEL_MEMBERS, [
    ['d', roomId],
    ...pubkeys.map((pk) => ['p', pk]),
  ]);
}

/** An admin-authored room-repository config event, authored by `author`. */
function repositoryBinding(
  author: typeof agent,
  opts: { remote?: string; communityId?: string } = {},
): NostrEvent {
  return signEvent(
    {
      pubkey: author.publicKey,
      created_at: Math.floor(Date.now() / 1000),
      kind: KIND_ROOM_REPOSITORY,
      tags: [
        ['d', `buzz-room-repository:${roomId}`],
        ['h', roomId],
        ['t', 'buzz-room-repository'],
        ['community', opts.communityId ?? roomCommunityId],
      ],
      content: JSON.stringify({
        key: 'github:42',
        name: 'widget',
        remote: opts.remote ?? 'git://github.com/acme/widget',
        localOnly: false,
        githubInstallationId: 77,
      }),
    },
    author.secretKey,
  );
}

/**
 * The relay-stamped channel→community row `relayCommunityIdForRoom` reads.
 * The table itself belongs to the Buzz relay's SQL schema (not AuthStore's
 * migrations), so this test owns a minimal copy of it.
 */
async function seedChannelCommunity(communityId: string): Promise<void> {
  await pglite.query(
    `CREATE TABLE IF NOT EXISTS channels (
       id UUID PRIMARY KEY,
       community_id UUID,
       deleted_at TIMESTAMP
     )`,
    [],
  );
  await pglite.query(`DELETE FROM channels WHERE id = $1`, [roomId]);
  await pglite.query(`INSERT INTO channels (id, community_id) VALUES ($1, $2)`, [
    roomId,
    communityId,
  ]);
}

/** The same succession row the recovery ceremony upserts in the store. */
async function recordSuccession(oldPubkey: string, newPubkey: string): Promise<void> {
  await pglite.query(
    `INSERT INTO beeline_key_successions
       (community, issuer, audience, subject, old_pubkey, new_pubkey, created_at)
     VALUES ($1, 'https://issuer.test', 'audience', 'subject-1', $2, $3, now())`,
    [tenant.community, oldPubkey, newPubkey],
  );
}

beforeEach(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
  database = new PgliteDatabase(pglite);
  store = new AuthStore(database);
  await store.migrate();
  await seedChannelCommunity(roomCommunityId);
  relay.getChannelCreator.mockReset().mockResolvedValue('c'.repeat(64));
  // Default wire state: the successor owns the Room, the agent is a member,
  // and the binding was authored by the PREDECESSOR key — the production
  // incident shape. Individual tests rearrange from here.
  relayEvents = [
    adminsProjection(ownerSuccessor.publicKey),
    membersProjection(ownerSuccessor.publicKey, agent.publicKey),
    repositoryBinding(ownerPredecessor),
  ];
  stubRelayQuery();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await database.close();
});

describe('GitHub Room token authority', () => {
  it('resolves a predecessor-authored binding through the owner succession chain', async () => {
    await recordSuccession(ownerPredecessor.publicKey, ownerSuccessor.publicKey);

    await expect(createGitHubRoomTokenAuthority(store)(tenant, input)).resolves.toEqual({
      authorized: true,
      authorizedBy: ownerPredecessor.publicKey,
      currentAuthorizedBy: ownerSuccessor.publicKey,
      fullName: 'acme/widget',
      githubInstallationId: 77,
    });
  });

  it('refuses a binding authored by an unrelated key even with ledger access', async () => {
    relayEvents[2] = repositoryBinding(stranger);

    await expect(createGitHubRoomTokenAuthority(store)(tenant, input)).resolves.toEqual({
      authorized: false,
      reason: 'room_repository_missing',
    });
  });

  it('degrades to pre-succession behavior when the ledger cannot be read', async () => {
    const failingLedger = {
      relayCommunityIdForRoom: store.relayCommunityIdForRoom.bind(store),
      resolveCurrentPubkey: async () => {
        throw new Error('ledger unavailable');
      },
    };

    await expect(createGitHubRoomTokenAuthority(failingLedger)(tenant, input)).resolves.toEqual({
      authorized: false,
      reason: 'room_repository_missing',
    });
  });

  it('authorizes with no succession recorded when the author IS the current owner', async () => {
    relayEvents[2] = repositoryBinding(ownerSuccessor);

    await expect(createGitHubRoomTokenAuthority(store)(tenant, input)).resolves.toEqual({
      authorized: true,
      authorizedBy: ownerSuccessor.publicKey,
      currentAuthorizedBy: ownerSuccessor.publicKey,
      fullName: 'acme/widget',
      githubInstallationId: 77,
    });
    expect(relay.getChannelCreator).not.toHaveBeenCalled();
  });

  it('uses the server-stamped SQL community instead of either client namespace', async () => {
    // The binding event carries a client-authored `community` tag naming a
    // different UUID; authority reads the channel row instead. It also
    // resolves through succession here: predecessor binding, successor owner.
    await recordSuccession(ownerPredecessor.publicKey, ownerSuccessor.publicKey);
    relayEvents[2] = repositoryBinding(ownerPredecessor, {
      communityId: 'a6814772-1f7f-4a59-850b-5579039efb17',
    });

    await expect(createGitHubRoomTokenAuthority(store)(tenant, input)).resolves.toMatchObject({
      authorized: true,
      fullName: 'acme/widget',
    });
  });

  it('authorizes Rooms from either relay community served by one tenant', async () => {
    await recordSuccession(ownerPredecessor.publicKey, ownerSuccessor.publicKey);
    await seedChannelCommunity(legacyRelayCommunityId);
    const legacyTenant: AuthTenant = { ...tenant, roomCommunityIds: [legacyRelayCommunityId] };

    await expect(
      createGitHubRoomTokenAuthority(store)(legacyTenant, input),
    ).resolves.toMatchObject({ authorized: true, fullName: 'acme/widget' });
  });

  it('refuses when the Room has no authoritative relay row for its community', async () => {
    await seedChannelCommunity('99999999-9999-4999-8999-999999999999');

    await expect(createGitHubRoomTokenAuthority(store)(tenant, input)).resolves.toEqual({
      authorized: false,
      reason: 'tenant_room_community_mismatch',
    });
  });

  it('refuses an agent that is not a current Room member', async () => {
    relayEvents[1] = membersProjection(ownerSuccessor.publicKey);

    await expect(createGitHubRoomTokenAuthority(store)(tenant, input)).resolves.toEqual({
      authorized: false,
      reason: 'agent_not_room_member',
    });
  });

  it('reports room_repository_missing when no repository binding exists anywhere', async () => {
    relayEvents = relayEvents.slice(0, 2);

    await expect(createGitHubRoomTokenAuthority(store)(tenant, input)).resolves.toEqual({
      authorized: false,
      reason: 'room_repository_missing',
    });
  });

  it('reports room_repository_remote_malformed for a non-git:// remote', async () => {
    // Authored by the current owner so resolution succeeds and the refusal
    // is specifically about the remote shape.
    relayEvents[2] = repositoryBinding(ownerSuccessor, {
      remote: 'https://github.com/acme/widget',
    });

    await expect(createGitHubRoomTokenAuthority(store)(tenant, input)).resolves.toEqual({
      authorized: false,
      reason: 'room_repository_remote_malformed',
    });
  });

  it('falls back to the current channel creator through a genesis-only Room', async () => {
    // No config event: only the immutable genesis binding on the create
    // event, which carries no author — authority falls back to the creator.
    relayEvents = [
      adminsProjection(ownerSuccessor.publicKey),
      membersProjection(ownerSuccessor.publicKey, agent.publicKey),
      signed(ownerSuccessor, KIND_CREATE_GROUP, [
        ['h', roomId],
        ['name', 'buzzy'],
        ['repo-key', 'github:42'],
        ['repo-name', 'widget'],
        ['repo-scope', 'remote'],
        ['repo-remote', 'git://github.com/acme/widget'],
      ]),
    ];

    await expect(createGitHubRoomTokenAuthority(store)(tenant, input)).resolves.toEqual({
      authorized: true,
      authorizedBy: 'c'.repeat(64),
      currentAuthorizedBy: 'c'.repeat(64),
      fullName: 'acme/widget',
    });
    expect(relay.getChannelCreator).toHaveBeenCalledWith(expect.anything(), roomId);
  });
});
