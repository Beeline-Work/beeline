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

  async function insertEvent(event: NostrEvent): Promise<void> {
    await database.query(
      `INSERT INTO events
         (community_id, id, pubkey, created_at, kind, tags, content, sig, channel_id)
       VALUES ($1, decode($2, 'hex'), decode($3, 'hex'), to_timestamp($4), $5,
               $6::jsonb, $7, decode($8, 'hex'), $9)`,
      [
        TENANT,
        event.id,
        event.pubkey,
        event.created_at,
        event.kind,
        JSON.stringify(event.tags),
        event.content,
        event.sig,
        CHANNEL,
      ],
    );
  }

  it('rebuilds relay rows through the shared parser/reducer into one persisted view', async () => {
    const owner = createIdentity('snapshot-owner');
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
    await insertEvent(
      signEvent(
        {
          pubkey: owner.publicKey,
          created_at: base + 2,
          kind: 9,
          tags: [['h', CHANNEL]],
          content: 'One projected request paints this row.',
        },
        owner.secretKey,
      ),
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
      createdAt: base + 2,
      eventIds: [expect.stringMatching(/^[0-9a-f]{64}$/)],
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
});
