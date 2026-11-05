import { describe } from 'vitest';
import { PgliteDatabase } from "../../apps/server/src/test-support.js";
import { migratedDatabase } from "../../apps/server/src/test-support.js";
import { cornerImplementerSql as oldWorker, cornerOwnerSql as oldOwner } from "../../apps/server/src/fixtures/rollout-0707-corner-worker.js";
import { cornerImplementerSql, cornerOwnerSql } from "../../apps/server/src/corner-worker.js";
import { starPromptReplySql } from "../../apps/server/src/github-star-prompt.js";
import { createAgentCommand, claimAgentCommand } from "../../apps/server/src/agent-command.js";
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import {
  assertSchemaCurrent, markSchemaCurrent, migrate, migrateData, postgresPoolConfig, PostgresDatabase,
  type ClosableDatabase, type DatabaseFailureKind,
} from '../../apps/server/src/database.js';

const url = process.env.BEELINE_COMMAND_TEST_POSTGRES_URL;
if (!url || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
  throw new Error('The server-db seam requires isolated loopback PostgreSQL');
const fixtureUrl = new URL(url);
const name = `beeline_seam_${randomUUID().replaceAll('-', '')}`;
fixtureUrl.pathname = '/' + name;
const admin = new Pool({ connectionString: url, max: 1 });
const observer = new Pool({ connectionString: fixtureUrl.href, max: 1 });
let pool: Pool;
let database: PostgresDatabase;

beforeAll(async () => {
  await admin.query(`CREATE DATABASE ${name}`);
  const bootstrap = new PostgresDatabase(fixtureUrl.href, 2, { mode: 'migration' });
  try {
    await migrate(bootstrap);
    // The release owner stamps readiness after schema and data steps complete.
    await markSchemaCurrent(bootstrap);
  } finally { await bootstrap.close(); }
  await observer.query('CREATE TABLE seam_effects(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, value text)');
});
beforeEach(async () => {
  await observer.query('TRUNCATE seam_effects');
  pool = new Pool(postgresPoolConfig(fixtureUrl.href, 2));
  database = new PostgresDatabase('', 2, { pool });
});
afterEach(async () => { await database?.close(); });
afterAll(async () => {
  await observer.end();
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.end();
});

// Lose the reply after PostgreSQL commits the real effect. There is no unique
// constraint or in-memory effect counter that could conceal a replay.
async function lostReply(kind: DatabaseFailureKind, boundary: 'INSERT' | 'COMMIT') {
  await observer.query('TRUNCATE seam_effects');
  const failure = Object.assign(new Error('injected driver failure'), { code: kind === 'unknown' ? 'XX000' : kind });
  const connect = pool.connect.bind(pool);
  let lost = false;
  let acquisitions = 0;
  pool.connect = (async () => {
    acquisitions++;
    const client = await connect();
    const query = client.query.bind(client);
    client.query = (async (sql: string, values?: unknown[]) => {
      const result = await query(sql, values);
      if (!lost && (boundary === 'COMMIT' ? sql === 'COMMIT' : sql.startsWith('INSERT'))) {
        lost = true;
        throw failure;
      }
      return result;
    }) as typeof client.query;
    return client;
  }) as typeof pool.connect;
  const insert = 'INSERT INTO seam_effects(value) VALUES($1) RETURNING id';
  const work = boundary === 'COMMIT'
    ? database.transaction(tx => tx.query(insert, ['committed']))
    : database.query(insert, ['committed']);
  await expect(work).rejects.toBe(failure);
  expect(lost).toBe(true);
  expect(acquisitions).toBe(1);
  expect((await observer.query('SELECT value FROM seam_effects')).rows).toEqual([{ value: 'committed' }]);
}

type MigrationEntry = keyof Pick<typeof import('../../apps/server/src/database.js'),
  'migrate' | 'migrateData' | 'markSchemaCurrent' | 'assertSchemaCurrent'>;
const cases = {
  query: async () => {
    expect((await database.query('SELECT $1::text value', ['received'])).rows).toEqual([{ value: 'received' }]);
    await lostReply('08006', 'INSERT');
  },
  transaction: async () => {
    await database.transaction(async tx => { await tx.query("INSERT INTO seam_effects(value) VALUES('committed')"); });
    const failure = new Error('rollback');
    await expect(database.transaction(async tx => {
      await tx.query("INSERT INTO seam_effects(value) VALUES('rolled back')");
      throw failure;
    })).rejects.toBe(failure);
    expect((await observer.query('SELECT value FROM seam_effects')).rows).toEqual([{ value: 'committed' }]);
    await lostReply('08006', 'COMMIT');
  },
  connectDedicated: async () => {
    for (const mode of ['app', 'enrichment', 'diagnostics', 'long-running', 'migration'] as const) {
      const configured = new PostgresDatabase(fixtureUrl.href, 2, { mode });
      try {
        const first = await configured.connectDedicated();
        try {
          const second = await configured.connectDedicated();
          try {
            expect((await first.query('SHOW jit')).rows).toEqual([{ jit: 'off' }]);
            expect((await second.query('SHOW jit')).rows).toEqual([{ jit: 'off' }]);
          } finally { second.release(); }
        } finally { first.release(); }
        expect((await configured.query('SHOW jit')).rows).toEqual([{ jit: 'off' }]);
      } finally { await configured.close(); }
    }
  },
  backgroundWork: async () => {
    database.backgroundWork.run(async () => { await database.query("INSERT INTO seam_effects(value) VALUES('detached')"); });
    await database.backgroundWork.drain();
    expect(database.backgroundWork.isEmpty).toBe(true);
    expect((await observer.query('SELECT value FROM seam_effects')).rows).toEqual([{ value: 'detached' }]);
  },
  close: async () => {
    database.backgroundWork.run(async () => { await database.query("INSERT INTO seam_effects(value) VALUES('before close')"); });
    await database.close();
    expect((await observer.query('SELECT value FROM seam_effects')).rows).toEqual([{ value: 'before close' }]);
    await expect(database.query('SELECT 1')).rejects.toThrow();
  },
  poolCounts: async () => {
    await database.query('SELECT 1');
    expect(database.poolCounts()).toEqual({ total: 1, idle: 1, waiting: 0 });
  },
  poolTelemetry: async () => {
    await database.query('SELECT 1');
    expect(database.poolTelemetry()).toMatchObject({ checkouts: 1, checkoutFailures: 0, deadlocks: 0 });
  },
  oldestActiveQueryAgeMs: async () => {
    const pending = database.query('SELECT 1');
    expect(await database.oldestActiveQueryAgeMs()).toBeTypeOf('number');
    await pending;
    expect(await database.oldestActiveQueryAgeMs()).toBeNull();
  },
  queryProfiles: async () => {
    await database.query('SELECT 1');
    expect(database.queryProfiles()).toMatchObject({ top: [{ calls: 1, errors: 0 }], overflow: 0 });
  },
  queryWindow: async () => {
    await database.query('SELECT 1');
    expect(database.queryWindow()).toMatchObject({ queryCount: 1, checkoutCount: 1 });
  },
  oldestActiveTransactionAgeMs: async () => {
    await database.transaction(async tx => {
      expect(database.oldestActiveTransactionAgeMs()).toBeTypeOf('number');
      await tx.query('SELECT 1');
    });
    expect(database.oldestActiveTransactionAgeMs()).toBeNull();
  },
  transactionDeadlineCount: async () => {
    await database.transaction(tx => tx.query('SELECT 1'));
    expect(database.transactionDeadlineCount()).toBe(0);
  },
  onRecovery: async () => {
    let recoveries = 0;
    const remove = database.onRecovery(() => { recoveries++; });
    await lostReply('08006', 'INSERT');
    expect(recoveries).toBe(0);
    await database.query('SELECT 1');
    await database.query('SELECT 1');
    expect(recoveries).toBe(1);
    remove();
  },
  migrate: async () => {
    const id = 'c'.repeat(64);
    await database.query("INSERT INTO identities(id,kind,name) VALUES($1,'human','Seam person')", [id]);
    try {
      await migrate(database);
      await assertSchemaCurrent(database);
      expect((await database.query('SELECT name FROM identities WHERE id=$1', [id])).rows).toEqual([{ name: 'Seam person' }]);
    } finally { await database.query('DELETE FROM identities WHERE id=$1', [id]); }
  },
  migrateData: async () => {
    await migrateData(database);
    await migrateData(database);
    await assertSchemaCurrent(database);
  },
  markSchemaCurrent: async () => {
    await database.query('DELETE FROM beeline_schema_state');
    await markSchemaCurrent(database);
    await expect(assertSchemaCurrent(database)).resolves.toBeUndefined();
  },
  assertSchemaCurrent: async () => {
    await database.query('UPDATE beeline_schema_state SET version=0');
    try { await expect(assertSchemaCurrent(database)).rejects.toThrow('schema'); }
    finally { await markSchemaCurrent(database); }
  },
  '57P01': () => lostReply('57P01', 'INSERT'),
  '57P03': () => lostReply('57P03', 'INSERT'),
  '53300': () => lostReply('53300', 'INSERT'),
  '08006': () => lostReply('08006', 'INSERT'),
  '08003': () => lostReply('08003', 'INSERT'),
  '08000': () => lostReply('08000', 'INSERT'),
  ETIMEDOUT: () => lostReply('ETIMEDOUT', 'INSERT'),
  EAI_AGAIN: () => lostReply('EAI_AGAIN', 'INSERT'),
  '40P01': () => lostReply('40P01', 'INSERT'),
  '55P03': () => lostReply('55P03', 'INSERT'),
  '57014': () => lostReply('57014', 'INSERT'),
  unknown: () => lostReply('unknown', 'INSERT'),
} satisfies Record<keyof ClosableDatabase | MigrationEntry | DatabaseFailureKind, () => Promise<void>>;

it.each(Object.entries(cases))('%s', async (_member, run) => { await run(); });


describe("database-background-work", () => {
  it('finishes a deferred observer across successive queries before closing its database', async () => {
    const database = new PgliteDatabase();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let started!: () => void;
    const firstQuery = new Promise<void>(resolve => { started = resolve; });
    const values: number[] = [];
    database.backgroundWork.run(async () => {
      values.push(Number((await database.query('SELECT 1 AS value')).rows[0]!.value));
      started();
      await held;
      values.push(Number((await database.query('SELECT 2 AS value')).rows[0]!.value));
    });
    await firstQuery;
    let closed = false;
    const closing = database.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    expect(closed).toBe(false);
    release();
    await closing;
    expect(values).toEqual([1, 2]);
    expect(closed).toBe(true);
  });
});


describe("rollout-overlap", () => {
  let db: PgliteDatabase;
  afterEach(async () => { await db?.close(); });
  const H = 'a'.repeat(64), A = 'b'.repeat(64);
  const W = '11111111-1111-4111-8111-111111111111', R = '22222222-2222-4222-8222-222222222222';
  const C = '33333333-3333-4333-8333-333333333333';
  async function fixture() {
    db = await migratedDatabase();
    await db.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Worker')`, [H,A]);
    await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [A,H]);
    await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Rollout proof')`, [W]);
    await db.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'Parent',$3)`, [R,W,H]);
    await db.query(`INSERT INTO rooms(id,workspace_id,parent_id,name,created_by) VALUES($1,$2,$3,'Corner',$4)`, [C,W,R,A]);
    await db.query(`INSERT INTO corner_facts(corner_id) VALUES($1)`, [C]);
  }
  
  it('rollout-0707: the exact released expressions survive both schema overlap directions and repeated migrations', async () => {
    // Sentry 466aa2408b8c47348aac9a16b97f527a, release 3fe0d1b17,
    // 2026-11-03 07:08:34 UTC: waiting_fact.owner_agent_id does not exist.
    await fixture();
    for (const alias of ['waiting_fact','fact','owner_fact']) {
      const query = `SELECT ${oldWorker(alias, 'corner')} worker,${oldOwner('corner.id')} owner
        FROM rooms corner JOIN corner_facts ${alias} ON ${alias}.corner_id=corner.id WHERE corner.id=$1`;
      expect((await db.query(query, [C])).rows[0]).toMatchObject({ worker: A });
    }
    await db.query(`UPDATE corner_facts SET owner_agent_id=$1 WHERE corner_id=$2`, [A,C]);
    await migrate(db);
    await migrate(db);
    expect((await db.query(`SELECT owner_agent_id FROM corner_facts WHERE corner_id=$1`, [C])).rows[0]).toEqual({ owner_agent_id: A });
    expect((await db.query(`SELECT ${cornerImplementerSql('fact','corner')} worker,${cornerOwnerSql('corner.id')} owner
      FROM rooms corner JOIN corner_facts fact ON fact.corner_id=corner.id WHERE corner.id=$1`, [C])).rows[0]).toMatchObject({ worker: A });
    // Also repair installations where the preceding release already dropped it.
    await db.query(`ALTER TABLE corner_facts DROP COLUMN owner_agent_id`);
    await migrate(db);
    await expect(db.query(`SELECT ${oldOwner('corner.id')} owner FROM rooms corner WHERE id=$1`, [C])).resolves.toMatchObject({ rowCount: 1 });
  }, 60_000);
  
  it('SERVER-27: a released reply upsert and the candidate upsert both commit through overlap and repair', async () => {
    // Sentry db04a711c86948d18b913312503ad871, 2026-11-02 21:21:58 UTC.
    await fixture();
    const source = 'e'.repeat(64);
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'A person asks')`, [source,R,H]);
    // Exact 75e48e93346e starPromptReplySql output. Keep the retired write frozen.
    const oldReply = `WITH command AS (SELECT $1::text root_source_message_id)
      INSERT INTO github_star_prompts AS prompt(identity_id,replies,reached_milestone)
       SELECT source.author_id,1,
         CASE WHEN 1=ANY(ARRAY[3,30,300]) THEN 1 ELSE 0 END
       FROM command command
       JOIN messages source ON source.id=command.root_source_message_id
       JOIN identities person ON person.id=source.author_id
         AND person.kind='human' AND NOT person.hidden_from_roster
       LIMIT 1
       ON CONFLICT(identity_id) DO UPDATE SET
         replies=prompt.replies+1,
         reached_milestone=CASE WHEN prompt.replies+1=ANY(ARRAY[3,30,300])
           THEN prompt.replies+1 ELSE prompt.reached_milestone END,
         updated_at=now()`;
    await db.query(oldReply, [source]);
    await db.query(`WITH command AS (SELECT $1::text root_source_message_id) ${starPromptReplySql('command')}`, [source]);
    await db.query(oldReply, [source]);
    await migrate(db);
    expect((await db.query(`SELECT replies,reached_milestone FROM github_star_prompts WHERE identity_id=$1`, [H])).rows[0])
      .toEqual({ replies: 3, reached_milestone: 3 });
    await db.query(`ALTER TABLE github_star_prompts DROP COLUMN reached_milestone`);
    await migrate(db);
    await db.query(oldReply, [source]);
    expect((await db.query(`SELECT replies FROM github_star_prompts WHERE identity_id=$1`, [H])).rows[0]).toEqual({ replies: 4 });
  }, 60_000);
});


describe("completed-command-turns", () => {
  it('stuck-turn-1: release migration closes orphan turns once and preserves a live claimed successor', async () => {
    const database = new PgliteDatabase();
    const human = 'a'.repeat(64),
      agent = 'b'.repeat(64);
    const workspace = '11111111-1111-4111-8111-111111111111',
      room = '22222222-2222-4222-8222-222222222222';
    try {
      await migrate(database, { deferData: true });
      await database.query(
        `INSERT INTO identities(id,kind,name) VALUES($1,'human','Owner'),($2,'agent','Ruby')`,
        [human, agent],
      );
      await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [agent, human]);
      await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Proof')`, [workspace]);
      await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Proof')`, [
        room,
        workspace,
      ]);
      await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
        VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member')`,
        [workspace, human, agent, room],
      );
      const orphanIds: string[] = [];
      for (let index = 0; index < 6; index++) {
        const request = String(index).repeat(64);
        await database.query(
          `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'@ruby work')`,
          [request, room, human],
        );
        const command = await createAgentCommand(database, {
          roomId: room,
          agentId: agent,
          sourceMessageId: request,
          reason: 'human_tag',
        });
        await claimAgentCommand(database, room, agent, command!.id, `old-${index}`);
        await database.query(
          `UPDATE agent_commands SET state='complete',completed_at=now()-interval '2 days' WHERE id=$1`,
          [command!.id],
        );
        await database.query(
          `UPDATE agent_turns SET created_at=now()-interval '2 days',generation_id='retired-generation' WHERE request_id=$1`,
          [request],
        );
        if (index < 5) orphanIds.push(request);
        else {
          const source = 'f'.repeat(64);
          await database.query(
            `INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'resume')`,
            [source, room, human],
          );
          const successor = await createAgentCommand(database, {
            roomId: room,
            agentId: agent,
            sourceMessageId: source,
            reason: 'resume',
            action: 'resume',
            turnRequestId: request,
          });
          await claimAgentCommand(database, room, agent, successor!.id, 'live-successor');
        }
      }
      await migrateData(database);
      expect(
        (
          await database.query(
            `SELECT status,failure_reason FROM agent_turns WHERE request_id=ANY($1::text[])`,
            [orphanIds],
          )
        ).rows,
      ).toEqual(
        Array.from({ length: 5 }, () => ({
          status: 'failed',
          failure_reason: 'the command completed without a terminal turn receipt',
        })),
      );
      expect(
        (
          await database.query(`SELECT status,generation_id FROM agent_turns WHERE request_id=$1`, [
            '5'.repeat(64),
          ])
        ).rows,
      ).toEqual([{ status: 'working', generation_id: 'live-successor' }]);
      // The release marker prevents a later release from running this repair again.
      await database.query(
        `UPDATE agent_commands SET state='complete' WHERE generation_id='live-successor'`,
      );
      await migrateData(database);
      expect(
        (await database.query(`SELECT status FROM agent_turns WHERE request_id=$1`, ['5'.repeat(64)]))
          .rows,
      ).toEqual([{ status: 'working' }]);
    } finally {
      await database.close();
    }
  });
});


describe("corner-names", () => {
  const WORKSPACE = '00000000-0000-4000-8000-000000000001';
  const ROOM = '00000000-0000-4000-8000-000000000010';
  const OTHER_ROOM = '00000000-0000-4000-8000-000000000020';
  const corner = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;
  const AUTHOR = 'a'.repeat(64);
  
  let database: PgliteDatabase;
  
  beforeEach(async () => {
    database = new PgliteDatabase();
    await migrate(database, { deferData: true });
    await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Author')`, [
      AUTHOR,
    ]);
    await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Hive')`, [WORKSPACE]);
    await database.query(
      `INSERT INTO rooms(id,workspace_id,name) VALUES($2,$1,'beeline'),($3,$1,'other')`,
      [WORKSPACE, ROOM, OTHER_ROOM],
    );
    const rows: [string, string, string, string, string?][] = [
      [corner(1), ROOM, 'fix-ledger', '2026-09-01'],
      [corner(2), ROOM, 'Fix ledger', '2026-09-02'],
      [corner(3), ROOM, 'fix  ledger drift and more words', '2026-09-03'],
      [corner(4), ROOM, 'fix ledger', '2026-09-04'],
      [corner(5), OTHER_ROOM, 'fix ledger', '2026-09-05'],
      [corner(6), ROOM, '   ', '2026-09-06'],
      // An archived name stays taken, and an archived spaced name is renamed too.
      [corner(7), ROOM, 'ship-it', '2026-09-07', '2026-09-08'],
      [corner(8), ROOM, 'ship it', '2026-09-09'],
      [corner(9), ROOM, 'old idea here', '2026-09-10', '2026-09-11'],
    ];
    for (const [id, parent, name, at, archivedAt] of rows) {
      await database.query(
        `INSERT INTO rooms(id,workspace_id,parent_id,name,created_at,archived_at)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [id, WORKSPACE, parent, name, at, archivedAt ?? null],
      );
    }
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text,card_type,card) VALUES
         ('m1',$1,$2,'','daemon-fact',jsonb_build_object('cornerId',$3::text,'name','Fix ledger')),
         ('m2',$1,$2,'','daemon-fact',jsonb_build_object('cornerId',$3::text,'objective','x'))`,
      [ROOM, AUTHOR, corner(2)],
    );
  });
  
  afterEach(async () => {
    await database.close();
  });
  
  async function names() {
    const result = await database.query<{ id: string; name: string }>(
      `SELECT id,name FROM rooms WHERE parent_id IS NOT NULL ORDER BY id`,
    );
    return Object.fromEntries(result.rows.map((row) => [row.id, row.name]));
  }
  
  it('hyphenates spaced corner names once, with deterministic suffixes per Room', async () => {
    await migrateData(database);
    expect(await names()).toEqual({
      [corner(1)]: 'fix-ledger',
      [corner(2)]: 'Fix-ledger-2',
      [corner(3)]: 'fix-ledger-drift',
      [corner(4)]: 'fix-ledger-3',
      [corner(5)]: 'fix-ledger',
      [corner(6)]: 'corner-00000000',
      [corner(7)]: 'ship-it',
      [corner(8)]: 'ship-it-2',
      [corner(9)]: 'old-idea-here',
    });
    const cards = await database.query<{ id: string; card: Record<string, unknown> }>(
      `SELECT id,card FROM messages ORDER BY id`,
    );
    expect(cards.rows.map((row) => row.card.name)).toEqual(['Fix-ledger-2', undefined]);
  
    await database.query(`UPDATE rooms SET name='spaced again' WHERE id=$1`, [corner(1)]);
    await migrateData(database);
    expect((await names())[corner(1)]).toBe('spaced again');
    console.log('Demonstrated corner-names backfill:', JSON.stringify(await names()));
  });
});
