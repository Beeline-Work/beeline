import { readFileSync } from 'node:fs';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { channelSnapshotDigest, type StoredChannelSnapshotV1 } from '@beeline/buzz-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseQueryable, DatabaseTransactional } from './database.js';
import { ChannelSnapshotStore } from './snapshot-store.js';

const TENANT = 'e8299f28-f095-472f-941a-80d1195b9a24';
const HOT = '9b929b0d-5189-4dbf-b6ba-a9f4ddf81bc6';
const COLD = '3f37b271-1a12-4d2a-b002-202b3f3582b9';
const SIBLING = '550e8400-e29b-41d4-a716-446655440000';

function goldenPayload(): StoredChannelSnapshotV1 {
  const view = JSON.parse(
    readFileSync(
      new URL(
        '../../../packages/buzz-client/src/read-model/fixtures/channel-snapshot-v1.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as Record<string, unknown>;
  const { lagMs: _lag, viewer: _viewer, integrity: _integrity, ...payload } = view;
  return payload as StoredChannelSnapshotV1;
}

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

  it('redirties every snapshot that embeds a changed family member', async () => {
    await database.query(
      `INSERT INTO channels (community_id, id) VALUES ($1, $2), ($1, $3), ($1, $4)`,
      [TENANT, HOT, COLD, SIBLING],
    );
    for (const [index, channelId] of [COLD, SIBLING].entries()) {
      await database.query(
        `INSERT INTO events
           (community_id, id, pubkey, created_at, kind, tags, content, sig, channel_id)
         VALUES ($1, decode($2, 'hex'), decode($3, 'hex'), now(), 9007,
                 $4::jsonb, '', decode($5, 'hex'), $6)`,
        [
          TENANT,
          (index + 1).toString(16).padStart(64, '0'),
          'a'.repeat(64),
          JSON.stringify([
            ['h', channelId],
            ['parent', HOT],
          ]),
          'f'.repeat(128),
          channelId,
        ],
      );
    }
    await database.query(`DELETE FROM beeline_snapshot_dirty`);

    await database.query(
      `INSERT INTO events
         (community_id, id, pubkey, created_at, kind, tags, content, sig, channel_id)
       VALUES ($1, decode($2, 'hex'), decode($3, 'hex'), now(), 30078,
               '[]'::jsonb, '{}', decode($4, 'hex'), $5)`,
      [TENANT, 'c'.repeat(64), 'a'.repeat(64), 'f'.repeat(128), SIBLING],
    );

    const dirty = await database.query<{ channel_id: string }>(
      `SELECT channel_id::text AS channel_id
       FROM beeline_snapshot_dirty
       WHERE relay_tenant_id = $1
       ORDER BY channel_id`,
      [TENANT],
    );
    expect(dirty.rows.map((row) => row.channel_id)).toEqual([HOT, COLD, SIBLING].sort());
  });

  it('redirties historical Rooms when a departed author changes identity', async () => {
    const author = 'a'.repeat(64);
    await database.query(`INSERT INTO channels (community_id, id) VALUES ($1, $2)`, [TENANT, HOT]);
    await database.query(
      `INSERT INTO channel_members (community_id, channel_id, pubkey, removed_at)
       VALUES ($1, $2, decode($3, 'hex'), now())`,
      [TENANT, HOT, author],
    );
    await database.query(`DELETE FROM beeline_snapshot_dirty`);

    await database.query(
      `INSERT INTO events
         (community_id, id, pubkey, created_at, kind, tags, content, sig, channel_id)
       VALUES ($1, decode($2, 'hex'), decode($3, 'hex'), now(), 0,
               '[]'::jsonb, '{}', decode($4, 'hex'), NULL)`,
      [TENANT, '1'.padStart(64, '0'), author, 'f'.repeat(128)],
    );

    const dirty = await database.query<{ channel_id: string }>(
      `SELECT channel_id::text AS channel_id
       FROM beeline_snapshot_dirty
       WHERE relay_tenant_id = $1`,
      [TENANT],
    );
    expect(dirty.rows.map((row) => row.channel_id)).toEqual([HOT]);
  });

  it('releases redirtied hot claims and selects a cold channel within two claims', async () => {
    await database.query(`INSERT INTO channels (community_id, id) VALUES ($1, $2)`, [TENANT, HOT]);
    await database.query(`INSERT INTO channels (community_id, id) VALUES ($1, $2)`, [TENANT, COLD]);
    await database.query(
      `UPDATE beeline_snapshot_dirty SET dirty_at = now() - interval '1 hour'
       WHERE relay_tenant_id = $1 AND channel_id = $2`,
      [TENANT, HOT],
    );
    const dirtyBeforeBurst = await database.query<{ dirty_at: Date }>(
      `SELECT dirty_at FROM beeline_snapshot_dirty
       WHERE relay_tenant_id = $1 AND channel_id = $2`,
      [TENANT, HOT],
    );
    const initialClaims = await store.claimDirty(2, 60_000);
    expect(initialClaims.map((claim) => claim.channelId)).toEqual([HOT, COLD]);

    for (const [index, claim] of initialClaims.entries()) {
      await database.query(
        `INSERT INTO events
           (community_id, id, pubkey, created_at, kind, tags, content, sig, channel_id)
         VALUES ($1, decode($2, 'hex'), decode($3, 'hex'), now(), 9, $4::jsonb, '', decode($5, 'hex'), $6)`,
        [
          TENANT,
          (index + 1).toString(16).padStart(64, '0'),
          'a'.repeat(64),
          JSON.stringify([['h', claim.channelId]]),
          'f'.repeat(128),
          claim.channelId,
        ],
      );
      await store.discard(claim);
    }

    const [hotClaim] = await store.claimDirty(1, 60_000);
    expect(hotClaim?.channelId).toBe(HOT);

    for (let index = 0; index < 40; index += 1) {
      await database.query(
        `INSERT INTO events
           (community_id, id, pubkey, created_at, kind, tags, content, sig, channel_id)
         VALUES ($1, decode($2, 'hex'), decode($3, 'hex'), now(), 9, $4::jsonb, '', decode($5, 'hex'), $6)`,
        [
          TENANT,
          (index + 100).toString(16).padStart(64, '0'),
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
    expect(dirtyAfterBurst.rows[0]!.dirty_at.getTime()).toBeGreaterThan(
      dirtyBeforeBurst.rows[0]!.dirty_at.getTime(),
    );
    await store.discard(hotClaim!);

    expect((await store.status()).depth).toBe(2);
    const [next] = await store.claimDirty(1, 60_000);
    expect(next?.channelId).toBe(COLD);
  });

  it('publishes a projection and retains work that arrived after its boundary', async () => {
    await database.query(`INSERT INTO channels (community_id, id) VALUES ($1, $2)`, [TENANT, HOT]);
    await database.query(
      `UPDATE beeline_snapshot_dirty SET dirty_at = now() - interval '1 hour'
       WHERE relay_tenant_id = $1 AND channel_id = $2`,
      [TENANT, HOT],
    );
    const [claim] = await store.claimDirty(1, 60_000);
    expect(claim).toBeDefined();

    const claimed = await database.query<{ dirty_at: Date }>(
      `SELECT dirty_at FROM beeline_snapshot_dirty
       WHERE relay_tenant_id = $1::uuid AND channel_id = $2::uuid`,
      [TENANT, HOT],
    );

    await database.query(`SELECT beeline_mark_snapshot_dirty($1::uuid, $2::uuid)`, [TENANT, HOT]);
    const payload = goldenPayload();
    await store.complete(claim!, payload, channelSnapshotDigest(payload));

    const snapshots = await database.query<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM beeline_channel_snapshot_v1
       WHERE relay_tenant_id = $1::uuid AND channel_id = $2::uuid`,
      [TENANT, HOT],
    );
    const dirty = await database.query<{
      dirty_revision: string | number;
      claimed_token: string | null;
      dirty_at: Date;
    }>(
      `SELECT dirty_revision, claimed_token, dirty_at FROM beeline_snapshot_dirty
       WHERE relay_tenant_id = $1::uuid AND channel_id = $2::uuid`,
      [TENANT, HOT],
    );
    expect(Number(snapshots.rows[0]?.count)).toBe(1);
    expect(Number(dirty.rows[0]?.dirty_revision)).toBeGreaterThan(claim!.dirtyRevision);
    expect(dirty.rows[0]?.claimed_token).toBeNull();
    expect(dirty.rows[0]!.dirty_at.getTime()).toBeGreaterThan(claimed.rows[0]!.dirty_at.getTime());
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

  it('loads the latest creator-authored state for every Corner outside the structural tail', async () => {
    await database.query(
      `INSERT INTO channels (community_id, id) VALUES ($1, $2), ($1, $3), ($1, $4)`,
      [TENANT, HOT, COLD, SIBLING],
    );
    const creator = 'a'.repeat(64);
    await database.query(
      `INSERT INTO events
         (community_id, id, pubkey, created_at, kind, tags, content, sig, channel_id)
       VALUES
         ($1, decode($2, 'hex'), decode($5, 'hex'), now() - interval '4 seconds', 9007,
          $6::jsonb, '', decode($8, 'hex'), $3),
         ($1, decode($9, 'hex'), decode($5, 'hex'), now() - interval '3 seconds', 9007,
          $10::jsonb, '', decode($8, 'hex'), $4),
         ($1, decode($11, 'hex'), decode($5, 'hex'), now() - interval '2 seconds', 9007,
          $12::jsonb, '', decode($8, 'hex'), $7)`,
      [
        TENANT,
        '1'.padStart(64, '0'),
        HOT,
        COLD,
        creator,
        JSON.stringify([['h', HOT]]),
        SIBLING,
        'f'.repeat(128),
        '2'.padStart(64, '0'),
        JSON.stringify([
          ['h', COLD],
          ['parent', HOT],
        ]),
        '3'.padStart(64, '0'),
        JSON.stringify([
          ['h', SIBLING],
          ['parent', HOT],
        ]),
      ],
    );
    const dormantStateId = '4'.padStart(64, '0');
    await database.query(
      `INSERT INTO events
         (community_id, id, pubkey, created_at, kind, tags, content, sig, channel_id)
       VALUES ($1, decode($2, 'hex'), decode($3, 'hex'), now() - interval '1 second', 30078,
               $4::jsonb, '', decode($5, 'hex'), $6)`,
      [
        TENANT,
        dormantStateId,
        creator,
        JSON.stringify([
          ['d', `buzz-corner-state:${COLD}`],
          ['h', HOT],
          ['t', 'buzz-corner-state'],
          ['state', 'waiting'],
          ['at', '1'],
          ['reason', 'review'],
        ]),
        'f'.repeat(128),
        HOT,
      ],
    );
    await database.query(
      `INSERT INTO events
         (community_id, id, pubkey, created_at, kind, tags, content, sig, channel_id)
       SELECT $1, decode(lpad(to_hex(sequence + 100), 64, '0'), 'hex'), decode($2, 'hex'),
              now() + sequence * interval '1 millisecond', 30078, $3::jsonb, '',
              decode($4, 'hex'), $5
       FROM generate_series(1, 2500) AS sequence`,
      [
        TENANT,
        creator,
        JSON.stringify([
          ['d', `buzz-corner-state:${SIBLING}`],
          ['h', HOT],
          ['t', 'buzz-corner-state'],
          ['state', 'working'],
          ['at', '2'],
        ]),
        'f'.repeat(128),
        HOT,
      ],
    );
    await database.query(`DELETE FROM beeline_snapshot_dirty`);
    await database.query(`SELECT beeline_mark_snapshot_dirty($1::uuid, $2::uuid)`, [TENANT, HOT]);
    const [claim] = await store.claimDirty(1, 60_000);
    const input = await store.loadProjectionInput(claim!);

    expect(input?.events.some((event) => event.id === dormantStateId)).toBe(true);
    expect(
      input?.events.filter(
        (event) =>
          event.kind === 30078 &&
          event.tags.some((tag) => tag[0] === 't' && tag[1] === 'buzz-corner-state'),
      ),
    ).toHaveLength(2);
  }, 30_000);

  it('loads current lifecycle and repository facts outside the structural tail', async () => {
    await database.query(`INSERT INTO channels (community_id, id) VALUES ($1, $2)`, [TENANT, HOT]);
    const author = 'a'.repeat(64);
    const nameId = '10'.padStart(64, '0');
    const archiveId = '11'.padStart(64, '0');
    const repositoryId = '12'.padStart(64, '0');
    await database.query(
      `INSERT INTO events
         (community_id, id, pubkey, created_at, kind, tags, content, sig, channel_id)
       VALUES
         ($1, decode($2, 'hex'), decode($5, 'hex'), now() - interval '3 seconds', 9002,
          $6::jsonb, '', decode($7, 'hex'), $8),
         ($1, decode($3, 'hex'), decode($5, 'hex'), now() - interval '2 seconds', 9002,
          $9::jsonb, '', decode($7, 'hex'), $8),
         ($1, decode($4, 'hex'), decode($5, 'hex'), now() - interval '1 second', 30078,
          $10::jsonb, $11, decode($7, 'hex'), $8)`,
      [
        TENANT,
        nameId,
        archiveId,
        repositoryId,
        author,
        JSON.stringify([
          ['h', HOT],
          ['name', 'Durable Room'],
        ]),
        'f'.repeat(128),
        HOT,
        JSON.stringify([
          ['h', HOT],
          ['archived', 'true'],
        ]),
        JSON.stringify([
          ['d', `buzz-room-repository:${HOT}`],
          ['h', HOT],
          ['t', 'buzz-room-repository'],
        ]),
        JSON.stringify({ key: 'github:1', name: 'beeline', remote: 'https://example.test/repo' }),
      ],
    );
    await database.query(
      `INSERT INTO events
         (community_id, id, pubkey, created_at, kind, tags, content, sig, channel_id)
       SELECT $1, decode(lpad(to_hex(sequence + 5000), 64, '0'), 'hex'), decode($2, 'hex'),
              now() + sequence * interval '1 millisecond', 30078,
              jsonb_build_array(jsonb_build_array('h', $3::text),
                                jsonb_build_array('d', 'noise:' || sequence::text)),
              '{}', decode($4, 'hex'), $3::uuid
       FROM generate_series(1, 2500) AS sequence`,
      [TENANT, author, HOT, 'f'.repeat(128)],
    );
    await database.query(`DELETE FROM beeline_snapshot_dirty`);
    await database.query(`SELECT beeline_mark_snapshot_dirty($1::uuid, $2::uuid)`, [TENANT, HOT]);
    const [claim] = await store.claimDirty(1, 60_000);
    const input = await store.loadProjectionInput(claim!);
    const eventIds = input?.events.map((event) => event.id) ?? [];

    expect(eventIds).toEqual(expect.arrayContaining([nameId, archiveId, repositoryId]));
  }, 30_000);
});
