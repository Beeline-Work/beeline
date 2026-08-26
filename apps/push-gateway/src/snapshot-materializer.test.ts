import { PGlite, type Transaction } from '@electric-sql/pglite';
import { signEvent, type NostrEvent } from '@beeline/nostr';
import { createIdentity, selectTranscript } from '@beeline/buzz-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseQueryable, DatabaseTransactional } from './database.js';
import { ChannelSnapshotMaterializer } from './snapshot-materializer.js';
import { ChannelSnapshotStore } from './snapshot-store.js';
import { SnapshotSuccessionClient } from './succession.js';

const TENANT = 'e8299f28-f095-472f-941a-80d1195b9a24';
const CHANNEL = '9b929b0d-5189-4dbf-b6ba-a9f4ddf81bc6';
const CORNER = '7d111868-52eb-43ab-98ae-8a6c49b92da8';
const COLD_CHANNEL = 'f0000000-0000-4000-8000-000000000001';

class PgliteDatabase implements DatabaseTransactional {
  constructor(private readonly postgres: PGlite) {}

  async query<Row>(text: string, values?: unknown[]) {
    if (values === undefined && text.includes('CREATE TABLE')) {
      await this.postgres.exec(text);
      return { rows: [] as Row[] };
    }
    const result = await this.postgres.query<Row>(text, values as never[] | undefined);
    return { rows: result.rows };
  }

  async transaction<T>(work: (database: DatabaseQueryable) => Promise<T>): Promise<T> {
    return this.postgres.transaction(async (transaction: Transaction) =>
      work({
        query: async <Row>(text: string, values?: unknown[]) => {
          const result = await transaction.query<Row>(text, values as never[] | undefined);
          return { rows: result.rows };
        },
      }),
    );
  }
}

describe('ChannelSnapshotMaterializer', () => {
  let postgres: PGlite;
  let database: PgliteDatabase;
  let store: ChannelSnapshotStore;

  beforeEach(async () => {
    postgres = new PGlite();
    await postgres.waitReady;
    database = new PgliteDatabase(postgres);
    await postgres.exec(`
      CREATE TABLE channels (
        community_id uuid NOT NULL,
        id uuid NOT NULL,
        visibility text NOT NULL DEFAULT 'private',
        deleted_at timestamptz,
        PRIMARY KEY (community_id, id)
      );
      CREATE TABLE channel_members (
        community_id uuid NOT NULL,
        channel_id uuid NOT NULL,
        pubkey bytea NOT NULL,
        removed_at timestamptz
      );
      CREATE TABLE events (
        community_id uuid NOT NULL,
        id bytea NOT NULL,
        pubkey bytea NOT NULL,
        created_at timestamptz NOT NULL,
        kind integer NOT NULL,
        tags jsonb NOT NULL,
        content text NOT NULL,
        sig bytea NOT NULL,
        channel_id uuid,
        deleted_at timestamptz
      );
    `);
    store = new ChannelSnapshotStore(database);
    await store.migrate();
  });

  afterEach(async () => {
    await postgres.close();
  });

  async function insertEvent(event: NostrEvent, channelId: string | null = CHANNEL): Promise<void> {
    await insertEvents([event], channelId);
  }

  async function insertEvents(
    events: readonly NostrEvent[],
    channelId: string | null = CHANNEL,
  ): Promise<void> {
    await database.query(
      `INSERT INTO events
         (community_id, id, pubkey, created_at, kind, tags, content, sig, channel_id)
       SELECT $1, decode(event->>'id', 'hex'), decode(event->>'pubkey', 'hex'),
              to_timestamp((event->>'created_at')::bigint), (event->>'kind')::integer,
              event->'tags', event->>'content', decode(event->>'sig', 'hex'), $3
       FROM jsonb_array_elements($2::jsonb) AS event`,
      [TENANT, JSON.stringify(events), channelId],
    );
  }

  it('rebuilds relay rows through the shared parser/reducer into one persisted view', async () => {
    const owner = createIdentity('snapshot-owner');
    const outsider = createIdentity('snapshot-outsider');
    await database.query(`INSERT INTO channels (community_id, id) VALUES ($1, $2)`, [
      TENANT,
      CHANNEL,
    ]);
    await database.query(
      `INSERT INTO channel_members (community_id, channel_id, pubkey)
       VALUES ($1, $2, decode($3, 'hex'))`,
      [TENANT, CHANNEL, owner.publicKey],
    );
    const base = Math.floor(Date.now() / 1_000) - 10;
    await insertEvent(
      signEvent(
        {
          pubkey: owner.publicKey,
          created_at: base,
          kind: 9007,
          tags: [
            ['h', CHANNEL],
            ['community', 'verified-application-workspace'],
            ['name', 'Snapshot Room'],
            ['p', owner.publicKey, 'owner'],
          ],
          content: '',
        },
        owner.secretKey,
      ),
    );
    await insertEvent(
      signEvent(
        {
          pubkey: owner.publicKey,
          created_at: base + 1,
          kind: 39002,
          tags: [
            ['d', CHANNEL],
            ['p', owner.publicKey, 'owner'],
          ],
          content: '',
        },
        owner.secretKey,
      ),
    );
    const projected = signEvent(
      {
        pubkey: owner.publicKey,
        created_at: base + 2,
        kind: 9,
        tags: [['h', CHANNEL]],
        content: 'One projected request paints this row.',
      },
      owner.secretKey,
    );
    const quarantined = signEvent(
      {
        pubkey: outsider.publicKey,
        created_at: base + 3,
        kind: 9,
        tags: [['h', CHANNEL]],
        content: 'This unauthorized row must not enter the projection.',
      },
      outsider.secretKey,
    );
    await insertEvents([projected, quarantined]);
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { pubkeys: string[] };
      return new Response(
        JSON.stringify({
          mappings: Object.fromEntries(body.pubkeys.map((pubkey) => [pubkey, pubkey])),
        }),
        { status: 200 },
      );
    });
    const succession = new SnapshotSuccessionClient({
      baseUrl: 'http://auth:8789',
      token: 'secret',
      fetch: fetchImpl,
    });
    const materializer = new ChannelSnapshotMaterializer(store, succession, {
      burstCoalesceMs: 0,
      log: () => undefined,
    });

    expect(await materializer.runOnce()).toBe(1);
    const served = await store.readForViewer(CHANNEL, owner.publicKey);
    expect(served?.payload?.snapshot.workspaceId).toBe('verified-application-workspace');
    expect(served?.payload?.snapshot.rooms[CHANNEL]?.metadata.name).toBe('Snapshot Room');
    expect(
      selectTranscript(served!.payload!.snapshot, CHANNEL)
        .filter((row) => row.kind === 'human-message')
        .map((row) => row.body),
    ).toEqual(['One projected request paints this row.']);
    expect(served?.payload?.cursor).toEqual({
      createdAt: base + 3,
      eventIds: [quarantined.id],
    });
    expect(served?.digest).toMatch(/^[0-9a-f]{64}$/);

    await database.query(
      `UPDATE channel_members SET removed_at = now()
       WHERE community_id = $1 AND channel_id = $2`,
      [TENANT, CHANNEL],
    );
    await expect(store.readForViewer(CHANNEL, owner.publicKey)).resolves.toBeNull();
    await expect(
      store.readForViewer('3f37b271-1a12-4d2a-b002-202b3f3582b9', owner.publicKey),
    ).resolves.toBeNull();
  });

  it('pages past an authorized sibling repository to the parent Room binding', async () => {
    const owner = createIdentity('snapshot-repository-owner');
    const member = createIdentity('snapshot-repository-member');
    await database.query(
      `INSERT INTO channels (community_id, id) VALUES ($1, $2), ($1, $3)`,
      [TENANT, CHANNEL, CORNER],
    );
    await database.query(
      `INSERT INTO channel_members (community_id, channel_id, pubkey)
       VALUES ($1, $2, decode($4, 'hex')),
              ($1, $2, decode($5, 'hex')),
              ($1, $3, decode($4, 'hex'))`,
      [TENANT, CHANNEL, CORNER, owner.publicKey, member.publicKey],
    );
    const base = Math.floor(Date.now() / 1_000) - 100;
    const parentRepositoryTags = [
      ['d', `buzz-room-repository:${CHANNEL}`],
      ['h', CHANNEL],
      ['t', 'buzz-room-repository'],
    ];
    const cornerRepositoryTags = [
      ['d', `buzz-room-repository:${CORNER}`],
      ['h', CORNER],
      ['t', 'buzz-room-repository'],
    ];
    const ownerRepository = signEvent(
      {
        pubkey: owner.publicKey,
        created_at: base + 1,
        kind: 30078,
        tags: parentRepositoryTags,
        content: JSON.stringify({
          key: 'github:authorized',
          name: 'Authorized repository',
          remote: 'https://example.test/authorized.git',
        }),
      },
      owner.secretKey,
    );
    const unauthorizedRepositories = Array.from({ length: 19 }, (_, index) =>
      signEvent(
        {
          pubkey: member.publicKey,
          created_at: base + index + 2,
          kind: 30078,
          tags: parentRepositoryTags,
          content: JSON.stringify({
            key: `github:unauthorized-${index}`,
            name: `Unauthorized repository ${index}`,
            remote: `https://example.test/unauthorized-${index}.git`,
          }),
        },
        member.secretKey,
      ),
    );
    const siblingRepository = signEvent(
      {
        pubkey: owner.publicKey,
        created_at: base + 21,
        kind: 30078,
        tags: cornerRepositoryTags,
        content: JSON.stringify({
          key: 'github:sibling',
          name: 'Sibling repository',
          remote: 'https://example.test/sibling.git',
        }),
      },
      owner.secretKey,
    );
    await insertEvents([
      signEvent(
        {
          pubkey: owner.publicKey,
          created_at: base,
          kind: 9007,
          tags: [
            ['h', CHANNEL],
            ['community', 'verified-application-workspace'],
            ['p', owner.publicKey, 'owner'],
            ['p', member.publicKey, 'member'],
          ],
          content: '',
        },
        owner.secretKey,
      ),
      ownerRepository,
      ...unauthorizedRepositories,
    ]);
    await insertEvents(
      [
        signEvent(
          {
            pubkey: owner.publicKey,
            created_at: base,
            kind: 9007,
            tags: [
              ['h', CORNER],
              ['parent', CHANNEL],
              ['community', 'verified-application-workspace'],
              ['p', owner.publicKey, 'owner'],
            ],
            content: '',
          },
          owner.secretKey,
        ),
        siblingRepository,
      ],
      CORNER,
    );
    await database.query(`DELETE FROM beeline_snapshot_dirty`);
    await database.query(`SELECT beeline_mark_snapshot_dirty($1::uuid, $2::uuid)`, [
      TENANT,
      CHANNEL,
    ]);
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { pubkeys: string[] };
      return new Response(
        JSON.stringify({
          mappings: Object.fromEntries(body.pubkeys.map((pubkey) => [pubkey, pubkey])),
        }),
        { status: 200 },
      );
    });
    const materializer = new ChannelSnapshotMaterializer(
      store,
      new SnapshotSuccessionClient({
        baseUrl: 'http://auth:8789',
        token: 'secret',
        fetch: fetchImpl,
      }),
      { burstCoalesceMs: 0, log: () => undefined },
    );

    expect(await materializer.runOnce()).toBe(1);
    expect((await store.readForViewer(CHANNEL, owner.publicKey))?.payload).toBeUndefined();
    expect((await store.status()).depth).toBe(1);

    expect(await materializer.runOnce()).toBe(1);
    const served = await store.readForViewer(CHANNEL, owner.publicKey);
    expect(served?.payload?.repository).toEqual({
      key: 'github:authorized',
      name: 'Authorized repository',
      remote: 'https://example.test/authorized.git',
    });
  });

  it('materializes an empty Corner from its parent lifecycle and live roster', async () => {
    const owner = createIdentity('snapshot-empty-corner-owner');
    await database.query(
      `INSERT INTO channels (community_id, id) VALUES ($1, $2), ($1, $3)`,
      [TENANT, CHANNEL, CORNER],
    );
    await database.query(
      `INSERT INTO channel_members (community_id, channel_id, pubkey)
       VALUES ($1, $2, decode($4, 'hex')), ($1, $3, decode($4, 'hex'))`,
      [TENANT, CHANNEL, CORNER, owner.publicKey],
    );
    const base = Math.floor(Date.now() / 1_000) - 10;
    const roomCreate = signEvent(
      {
        pubkey: owner.publicKey,
        created_at: base,
        kind: 9007,
        tags: [
          ['h', CHANNEL],
          ['community', 'verified-application-workspace'],
          ['name', 'Snapshot Room'],
        ],
        content: '',
      },
      owner.secretKey,
    );
    const cornerCreate = signEvent(
      {
        pubkey: owner.publicKey,
        created_at: base + 1,
        kind: 9007,
        tags: [
          ['h', CORNER],
          ['parent', CHANNEL],
          ['community', 'verified-application-workspace'],
          ['name', 'Empty Corner'],
        ],
        content: '',
      },
      owner.secretKey,
    );
    await insertEvent(roomCreate, CHANNEL);
    await insertEvent(cornerCreate, CORNER);
    await database.query(`DELETE FROM beeline_snapshot_dirty`);
    await database.query(`SELECT beeline_mark_snapshot_dirty($1::uuid, $2::uuid)`, [
      TENANT,
      CORNER,
    ]);
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { pubkeys: string[] };
      return new Response(
        JSON.stringify({
          mappings: Object.fromEntries(body.pubkeys.map((pubkey) => [pubkey, pubkey])),
        }),
        { status: 200 },
      );
    });
    const logs: string[] = [];
    const materializer = new ChannelSnapshotMaterializer(
      store,
      new SnapshotSuccessionClient({
        baseUrl: 'http://auth:8789',
        token: 'secret',
        fetch: fetchImpl,
      }),
      { burstCoalesceMs: 0, log: (line) => logs.push(line) },
    );

    expect(await materializer.runOnce()).toBe(1);
    const served = await store.readForViewer(CORNER, owner.publicKey);
    expect(served?.payload, logs.join('\n')).toBeDefined();
    const cornerRoom = served?.payload?.snapshot.rooms[CORNER];
    expect(cornerRoom?.membership).toMatchObject({
      status: 'known',
      members: { [owner.publicKey]: { pubkey: owner.publicKey, role: 'owner' } },
      sourceEventId: cornerCreate.id,
      observedAt: base + 1,
    });
    expect(cornerRoom?.eventJournal).toEqual({});
    expect(served?.payload?.snapshot.rooms[CHANNEL]?.corners[CORNER]).toMatchObject({
      kind: 'active',
      id: CORNER,
      parentRoomId: CHANNEL,
      name: 'Empty Corner',
    });
  });

  it('retains historical messages after their author leaves the Room', async () => {
    const owner = createIdentity('snapshot-current-owner');
    const departed = createIdentity('snapshot-departed-member');
    const profileless = createIdentity('snapshot-profileless-departed-member');
    await database.query(`INSERT INTO channels (community_id, id) VALUES ($1, $2)`, [
      TENANT,
      CHANNEL,
    ]);
    await database.query(
      `INSERT INTO channel_members (community_id, channel_id, pubkey, removed_at)
       VALUES ($1, $2, decode($3, 'hex'), NULL),
              ($1, $2, decode($4, 'hex'), now()),
              ($1, $2, decode($5, 'hex'), now())`,
      [TENANT, CHANNEL, owner.publicKey, departed.publicKey, profileless.publicKey],
    );
    const base = Math.floor(Date.now() / 1_000) - 10;
    const unauthorizedApproval = signEvent(
      {
        pubkey: profileless.publicKey,
        created_at: base + 3,
        kind: 9,
        tags: [
          ['h', CHANNEL],
          ['t', 'buzz-merge-approval'],
          ['repo', 'lunchboxfortwo/beeline'],
          ['branch', 'main'],
        ],
        content: 'APPROVE',
      },
      profileless.secretKey,
    );
    await insertEvents([
      signEvent(
        {
          pubkey: owner.publicKey,
          created_at: base,
          kind: 9007,
          tags: [
            ['h', CHANNEL],
            ['community', 'verified-application-workspace'],
            ['p', owner.publicKey, 'owner'],
            ['p', departed.publicKey, 'member'],
            ['p', profileless.publicKey, 'admin'],
          ],
          content: '',
        },
        owner.secretKey,
      ),
      signEvent(
        {
          pubkey: departed.publicKey,
          created_at: base + 1,
          kind: 9,
          tags: [['h', CHANNEL]],
          content: 'History remains after I leave.',
        },
        departed.secretKey,
      ),
      signEvent(
        {
          pubkey: profileless.publicKey,
          created_at: base + 2,
          kind: 9,
          tags: [['h', CHANNEL]],
          content: 'Profileless history remains after I leave.',
        },
        profileless.secretKey,
      ),
      unauthorizedApproval,
    ]);
    await insertEvent(
      signEvent(
        {
          pubkey: departed.publicKey,
          created_at: base + 4,
          kind: 0,
          tags: [],
          content: JSON.stringify({ display_name: 'Former Member' }),
        },
        departed.secretKey,
      ),
      null,
    );
    await insertEvents(
      Array.from({ length: 1_000 }, (_, index) =>
        signEvent(
          {
            pubkey: owner.publicKey,
            created_at: base + 5 + index,
            kind: 0,
            tags: [],
            content: JSON.stringify({ display_name: `Current Owner ${index}` }),
          },
          owner.secretKey,
        ),
      ),
      null,
    );
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { pubkeys: string[] };
      return new Response(
        JSON.stringify({
          mappings: Object.fromEntries(body.pubkeys.map((pubkey) => [pubkey, pubkey])),
        }),
        { status: 200 },
      );
    });
    const materializer = new ChannelSnapshotMaterializer(
      store,
      new SnapshotSuccessionClient({
        baseUrl: 'http://auth:8789',
        token: 'secret',
        fetch: fetchImpl,
      }),
      { burstCoalesceMs: 0, log: () => undefined },
    );

    expect(await materializer.runOnce()).toBe(1);
    const served = await store.readForViewer(CHANNEL, owner.publicKey);
    expect(
      selectTranscript(served!.payload!.snapshot, CHANNEL)
        .filter((row) => row.kind === 'human-message')
        .map((row) => row.body),
    ).toEqual([
      'History remains after I leave.',
      'Profileless history remains after I leave.',
    ]);
    expect(
      served?.payload?.snapshot.rooms[CHANNEL]?.eventJournal[unauthorizedApproval.id],
    ).toBeUndefined();
    expect(served?.payload?.snapshot.rooms[CHANNEL]?.membership).toMatchObject({
      status: 'known',
      members: { [owner.publicKey]: { pubkey: owner.publicKey } },
    });
    expect(served?.payload?.snapshot.rooms[CHANNEL]?.membership).not.toMatchObject({
      members: { [departed.publicKey]: expect.anything() },
    });
    expect(served?.payload?.snapshot.rooms[CHANNEL]?.membership).not.toMatchObject({
      members: { [profileless.publicKey]: expect.anything() },
    });
  }, 30_000);

  it('pages past hidden machine traffic to retain 30 conversation rows', async () => {
    const owner = createIdentity('snapshot-tail-owner');
    await database.query(`INSERT INTO channels (community_id, id) VALUES ($1, $2)`, [
      TENANT,
      CHANNEL,
    ]);
    await database.query(
      `INSERT INTO channel_members (community_id, channel_id, pubkey)
       VALUES ($1, $2, decode($3, 'hex'))`,
      [TENANT, CHANNEL, owner.publicKey],
    );
    const base = Math.floor(Date.now() / 1_000) - 1_000;
    const signed = (createdAt: number, kind: number, tags: string[][], content: string) =>
      signEvent(
        { pubkey: owner.publicKey, created_at: createdAt, kind, tags, content },
        owner.secretKey,
      );
    const events = [
      signed(
        base,
        9007,
        [
          ['h', CHANNEL],
          ['community', 'verified-application-workspace'],
          ['p', owner.publicKey, 'owner'],
        ],
        '',
      ),
      signed(
        base + 1,
        39002,
        [
          ['d', CHANNEL],
          ['p', owner.publicKey, 'owner'],
        ],
        '',
      ),
      ...Array.from({ length: 30 }, (_, index) =>
        signed(base + 2 + index, 9, [['h', CHANNEL]], `message ${index}`),
      ),
      ...Array.from({ length: 160 }, (_, index) =>
        signed(
          base + 100 + index,
          9,
          [
            ['h', CHANNEL],
            ['t', 'buzz-merge-approval'],
            ['repo', 'lunchboxfortwo/beeline'],
            ['branch', 'main'],
          ],
          'APPROVE',
        ),
      ),
    ];
    await insertEvents(events);
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { pubkeys: string[] };
      return new Response(
        JSON.stringify({
          mappings: Object.fromEntries(body.pubkeys.map((pubkey) => [pubkey, pubkey])),
        }),
        { status: 200 },
      );
    });
    const materializer = new ChannelSnapshotMaterializer(
      store,
      new SnapshotSuccessionClient({
        baseUrl: 'http://auth:8789',
        token: 'secret',
        fetch: fetchImpl,
      }),
      { burstCoalesceMs: 0, log: () => undefined },
    );

    expect(await materializer.runOnce()).toBe(1);
    const served = await store.readForViewer(CHANNEL, owner.publicKey);
    expect(
      selectTranscript(served!.payload!.snapshot, CHANNEL)
        .filter((row) => row.kind === 'human-message')
        .map((row) => row.body),
    ).toEqual(Array.from({ length: 30 }, (_, index) => `message ${index}`));
  }, 30_000);

  it('counts only persisted transcript rows before ending the message scan', async () => {
    const owner = createIdentity('snapshot-persisted-count-owner');
    const agent = createIdentity('snapshot-persisted-count-agent');
    await database.query(`INSERT INTO channels (community_id, id) VALUES ($1, $2)`, [
      TENANT,
      CHANNEL,
    ]);
    await database.query(
      `INSERT INTO channel_members (community_id, channel_id, pubkey)
       VALUES ($1, $2, decode($3, 'hex')), ($1, $2, decode($4, 'hex'))`,
      [TENANT, CHANNEL, owner.publicKey, agent.publicKey],
    );
    const base = Math.floor(Date.now() / 1_000) - 5_000;
    const signed = (
      source: typeof owner,
      createdAt: number,
      kind: number,
      tags: string[][],
      content: string,
    ) =>
      signEvent(
        { pubkey: source.publicKey, created_at: createdAt, kind, tags, content },
        source.secretKey,
      );
    await insertEvents([
      signed(
        owner,
        base,
        9007,
        [
          ['h', CHANNEL],
          ['community', 'verified-application-workspace'],
          ['p', owner.publicKey, 'owner'],
          ['p', agent.publicKey, 'member'],
        ],
        '',
      ),
      signed(
        owner,
        base + 1,
        39002,
        [
          ['d', CHANNEL],
          ['p', owner.publicKey, 'owner'],
          ['p', agent.publicKey, 'member'],
        ],
        '',
      ),
      ...Array.from({ length: 30 }, (_, index) =>
        signed(owner, base + 2 + index, 9, [['h', CHANNEL]], `message ${index}`),
      ),
      ...Array.from({ length: 130 }, (_, index) =>
        signed(
          owner,
          base + 100 + index,
          9,
          [
            ['h', CHANNEL],
            ['t', 'buzz-merge-approval'],
            ['repo', 'lunchboxfortwo/beeline'],
            ['branch', 'main'],
          ],
          'APPROVE',
        ),
      ),
      signed(
        agent,
        base + 300,
        9,
        [
          ['h', CHANNEL],
          ['t', 'body-control'],
          ['t', 'agent-turn'],
          ['request', 'request-1'],
          ['session', 'session-1'],
          ['agent', agent.publicKey],
          ['status', 'working'],
        ],
        'working',
      ),
      signed(
        agent,
        base + 301,
        30078,
        [
          ['d', `agent-draft:${CHANNEL}`],
          ['h', CHANNEL],
          ['t', 'agent-draft'],
          ['agent', agent.publicKey],
          ['session', 'session-1'],
          ['request', 'request-1'],
        ],
        'draft in progress',
      ),
    ]);
    await insertEvent(
      signed(
        agent,
        base + 50,
        9,
        [
          ['t', 'buzz-agent'],
          ['agent', agent.publicKey],
        ],
        JSON.stringify({ displayName: 'Snapshot Agent' }),
      ),
      null,
    );
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { pubkeys: string[] };
      return new Response(
        JSON.stringify({
          mappings: Object.fromEntries(body.pubkeys.map((pubkey) => [pubkey, pubkey])),
        }),
        { status: 200 },
      );
    });
    const materializer = new ChannelSnapshotMaterializer(
      store,
      new SnapshotSuccessionClient({
        baseUrl: 'http://auth:8789',
        token: 'secret',
        fetch: fetchImpl,
      }),
      { burstCoalesceMs: 0, log: () => undefined },
    );

    expect(await materializer.runOnce()).toBe(1);
    const served = await store.readForViewer(CHANNEL, owner.publicKey);
    const transcript = selectTranscript(served!.payload!.snapshot, CHANNEL);
    expect(transcript.map((row) => row.kind)).toEqual(Array(30).fill('human-message'));
    expect(transcript.map((row) => ('body' in row ? row.body : undefined))).toEqual(
      Array.from({ length: 30 }, (_, index) => `message ${index}`),
    );
  }, 30_000);

  it('exact-loads same-Room reply parents outside the transcript page', async () => {
    const owner = createIdentity('snapshot-reply-owner');
    await database.query(`INSERT INTO channels (community_id, id) VALUES ($1, $2)`, [
      TENANT,
      CHANNEL,
    ]);
    await database.query(
      `INSERT INTO channel_members (community_id, channel_id, pubkey)
       VALUES ($1, $2, decode($3, 'hex'))`,
      [TENANT, CHANNEL, owner.publicKey],
    );
    const base = Math.floor(Date.now() / 1_000) - 5_000;
    const signed = (createdAt: number, kind: number, tags: string[][], content: string) =>
      signEvent(
        { pubkey: owner.publicKey, created_at: createdAt, kind, tags, content },
        owner.secretKey,
      );
    const parents = Array.from({ length: 30 }, (_, index) =>
      signed(base + 2 + index, 9, [['h', CHANNEL]], `parent ${index}`),
    );
    const replies = parents.map((parent, index) =>
      signed(
        base + 100 + index,
        9,
        [
          ['h', CHANNEL],
          ['e', parent.id, '', 'reply'],
        ],
        `reply ${index}`,
      ),
    );
    await insertEvents([
      signed(
        base,
        9007,
        [
          ['h', CHANNEL],
          ['community', 'verified-application-workspace'],
          ['p', owner.publicKey, 'owner'],
        ],
        '',
      ),
      signed(
        base + 1,
        39002,
        [
          ['d', CHANNEL],
          ['p', owner.publicKey, 'owner'],
        ],
        '',
      ),
      ...parents,
      ...replies,
      ...Array.from({ length: 130 }, (_, index) =>
        signed(
          base + 200 + index,
          9,
          [
            ['h', CHANNEL],
            ['t', 'buzz-merge-approval'],
            ['repo', 'lunchboxfortwo/beeline'],
            ['branch', 'main'],
          ],
          'APPROVE',
        ),
      ),
    ]);
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { pubkeys: string[] };
      return new Response(
        JSON.stringify({
          mappings: Object.fromEntries(body.pubkeys.map((pubkey) => [pubkey, pubkey])),
        }),
        { status: 200 },
      );
    });
    const materializer = new ChannelSnapshotMaterializer(
      store,
      new SnapshotSuccessionClient({
        baseUrl: 'http://auth:8789',
        token: 'secret',
        fetch: fetchImpl,
      }),
      { burstCoalesceMs: 0, log: () => undefined },
    );

    expect(await materializer.runOnce()).toBe(1);
    const served = await store.readForViewer(CHANNEL, owner.publicKey);
    const transcript = selectTranscript(served!.payload!.snapshot, CHANNEL);
    expect(transcript).toHaveLength(30);
    const retainedReplies = transcript.filter(
      (row) => 'body' in row && row.body.startsWith('reply '),
    );
    expect(retainedReplies.map((row) => ('body' in row ? row.body : undefined))).toEqual(
      Array.from({ length: 15 }, (_, index) => `reply ${index + 15}`),
    );
    expect(retainedReplies.map((row) => ('reply' in row ? row.reply?.eventId : undefined))).toEqual(
      parents.slice(15).map((parent) => parent.id),
    );
    expect(
      Object.values(served!.payload!.snapshot.rooms[CHANNEL]!.eventJournal).filter(
        (event) => event.type === 'human-message' || event.type === 'agent-message',
      ),
    ).toHaveLength(30);
  }, 30_000);

  it('yields a deep hidden-history scan so a cold channel runs next', async () => {
    const owner = createIdentity('snapshot-bounded-owner');
    await database.query(`INSERT INTO channels (community_id, id) VALUES ($1, $2), ($1, $3)`, [
      TENANT,
      CHANNEL,
      COLD_CHANNEL,
    ]);
    await database.query(
      `INSERT INTO channel_members (community_id, channel_id, pubkey)
       VALUES ($1, $2, decode($4, 'hex')), ($1, $3, decode($4, 'hex'))`,
      [TENANT, CHANNEL, COLD_CHANNEL, owner.publicKey],
    );
    const base = Math.floor(Date.now() / 1_000) - 2_000;
    const signed = (
      _channelId: string,
      createdAt: number,
      kind: number,
      tags: string[][],
      content: string,
    ) =>
      signEvent(
        { pubkey: owner.publicKey, created_at: createdAt, kind, tags, content },
        owner.secretKey,
      );
    await insertEvents(
      [
        signed(
          CHANNEL,
          base,
          9007,
          [
            ['h', CHANNEL],
            ['community', 'verified-application-workspace'],
            ['p', owner.publicKey, 'owner'],
          ],
          '',
        ),
        signed(
          CHANNEL,
          base + 1,
          39002,
          [
            ['d', CHANNEL],
            ['p', owner.publicKey, 'owner'],
          ],
          '',
        ),
        ...Array.from({ length: 30 }, (_, index) =>
          signed(CHANNEL, base + 2 + index, 9, [['h', CHANNEL]], `message ${index}`),
        ),
        ...Array.from({ length: 321 }, (_, index) =>
          signed(
            CHANNEL,
            base + 100 + index,
            9,
            [
              ['h', CHANNEL],
              ['t', 'buzz-merge-approval'],
              ['repo', 'lunchboxfortwo/beeline'],
              ['branch', 'main'],
            ],
            'APPROVE',
          ),
        ),
      ],
      CHANNEL,
    );
    await insertEvents(
      [
        signed(
          COLD_CHANNEL,
          base,
          9007,
          [
            ['h', COLD_CHANNEL],
            ['community', 'verified-application-workspace'],
            ['p', owner.publicKey, 'owner'],
          ],
          '',
        ),
        signed(
          COLD_CHANNEL,
          base + 1,
          39002,
          [
            ['d', COLD_CHANNEL],
            ['p', owner.publicKey, 'owner'],
          ],
          '',
        ),
        signed(COLD_CHANNEL, base + 2, 9, [['h', COLD_CHANNEL]], 'cold message'),
      ],
      COLD_CHANNEL,
    );
    const fetchImpl = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { pubkeys: string[] };
      return new Response(
        JSON.stringify({
          mappings: Object.fromEntries(body.pubkeys.map((pubkey) => [pubkey, pubkey])),
        }),
        { status: 200 },
      );
    });
    const materializer = new ChannelSnapshotMaterializer(
      store,
      new SnapshotSuccessionClient({
        baseUrl: 'http://auth:8789',
        token: 'secret',
        fetch: fetchImpl,
      }),
      {
        batchSize: 1,
        burstCoalesceMs: 0,
        maxMessagePagesPerClaim: 2,
        log: () => undefined,
      },
    );

    expect(await materializer.runOnce()).toBe(1);
    expect((await store.readForViewer(CHANNEL, owner.publicKey))?.payload).toBeUndefined();

    expect(await materializer.runOnce()).toBe(1);
    expect((await store.readForViewer(COLD_CHANNEL, owner.publicKey))?.payload).toBeDefined();

    expect(await materializer.runOnce()).toBe(1);
    const hot = await store.readForViewer(CHANNEL, owner.publicKey);
    expect(
      selectTranscript(hot!.payload!.snapshot, CHANNEL)
        .filter((row) => row.kind === 'human-message')
        .map((row) => row.body),
    ).toEqual(Array.from({ length: 30 }, (_, index) => `message ${index}`));
  }, 30_000);
});
