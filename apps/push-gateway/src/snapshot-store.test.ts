import { PGlite, type Transaction } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseQueryable, DatabaseTransactional } from './database.js';
import { ChannelSnapshotStore } from './snapshot-store.js';

const TENANT = 'e8299f28-f095-472f-941a-80d1195b9a24';
const HOT = '9b929b0d-5189-4dbf-b6ba-a9f4ddf81bc6';
const COLD = '3f37b271-1a12-4d2a-b002-202b3f3582b9';

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

describe('ChannelSnapshotStore dirty worklist', () => {
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

  it('coalesces a hot channel to one dirty row and lets a cold channel claim next', async () => {
    await database.query(`INSERT INTO channels (community_id, id) VALUES ($1, $2)`, [TENANT, HOT]);
    const dirtyBeforeBurst = await database.query<{ dirty_at: Date }>(
      `SELECT dirty_at FROM beeline_snapshot_dirty
       WHERE relay_tenant_id = $1 AND channel_id = $2`,
      [TENANT, HOT],
    );
    const [hotClaim] = await store.claimDirty(1, 60_000);
    expect(hotClaim?.channelId).toBe(HOT);

    for (let index = 0; index < 40; index += 1) {
      await database.query(
        `INSERT INTO events
           (community_id, id, pubkey, created_at, kind, tags, content, sig, channel_id)
         VALUES ($1, decode($2, 'hex'), decode($3, 'hex'), now(), 9, $4::jsonb, '', decode($5, 'hex'), $6)`,
        [
          TENANT,
          index.toString(16).padStart(64, '0'),
          'a'.repeat(64),
          JSON.stringify([['h', HOT]]),
          'f'.repeat(128),
          HOT,
        ],
      );
    }
    const dirtyAfterBurst = await database.query<{ dirty_at: Date }>(
      `SELECT dirty_at FROM beeline_snapshot_dirty
       WHERE relay_tenant_id = $1 AND channel_id = $2`,
      [TENANT, HOT],
    );
    expect(dirtyAfterBurst.rows[0]?.dirty_at).toEqual(dirtyBeforeBurst.rows[0]?.dirty_at);
    await database.query(`INSERT INTO channels (community_id, id) VALUES ($1, $2)`, [TENANT, COLD]);

    expect((await store.status()).depth).toBe(2);
    const [next] = await store.claimDirty(1, 60_000);
    expect(next?.channelId).toBe(COLD);
  });

  it('drops deleted channels without acknowledging a newer dirty generation', async () => {
    await database.query(`INSERT INTO channels (community_id, id) VALUES ($1, $2)`, [TENANT, HOT]);
    const [claim] = await store.claimDirty(1, 60_000);
    expect(claim).toBeDefined();

    await database.query(
      `UPDATE channels SET deleted_at = now() WHERE community_id = $1 AND id = $2`,
      [TENANT, HOT],
    );
    await expect(store.loadProjectionInput(claim!)).resolves.toBeNull();
    await store.discard(claim!);

    expect((await store.status()).depth).toBe(1);
    const [deletionClaim] = await store.claimDirty(1, 60_000);
    expect(deletionClaim?.dirtyRevision).toBeGreaterThan(claim!.dirtyRevision);
    await store.discard(deletionClaim!);
    expect((await store.status()).depth).toBe(0);
  });

  it('keeps durable review status controls outside the generic message tail', async () => {
    await database.query(`INSERT INTO channels (community_id, id) VALUES ($1, $2)`, [TENANT, HOT]);
    const controlId = 'e'.repeat(64);
    await database.query(
      `INSERT INTO events
         (community_id, id, pubkey, created_at, kind, tags, content, sig, channel_id)
       VALUES ($1, decode($2, 'hex'), decode($3, 'hex'), now() - interval '1 second', 9,
               $4::jsonb, 'Ready', decode($5, 'hex'), $6)`,
      [
        TENANT,
        controlId,
        'a'.repeat(64),
        JSON.stringify([
          ['h', HOT],
          ['t', 'merge-ready'],
        ]),
        'f'.repeat(128),
        HOT,
      ],
    );
    await database.query(
      `INSERT INTO events
         (community_id, id, pubkey, created_at, kind, tags, content, sig, channel_id)
       SELECT $1, decode(lpad(to_hex(sequence), 64, '0'), 'hex'), decode($2, 'hex'),
              now(), 9, $3::jsonb, 'chat', decode($4, 'hex'), $5
       FROM generate_series(1, 170) AS sequence`,
      [TENANT, 'a'.repeat(64), JSON.stringify([['h', HOT]]), 'f'.repeat(128), HOT],
    );
    const [claim] = await store.claimDirty(1, 60_000);
    const input = await store.loadProjectionInput(claim!);

    expect(input?.events.some((event) => event.id === controlId)).toBe(true);
  });
});
