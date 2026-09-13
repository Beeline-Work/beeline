import { mkdir, writeFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QueryResultRow } from 'pg';
import { PushDeliveryLoop } from './background.js';
import { ConnectionPresence } from './connection-presence.js';
import { migrate, type QueryResult, type SqlDatabase } from './database.js';
import { LiveHub } from './live.js';
import { PhoneService } from './phone-service.js';
import {
  assertHotRead,
  explainHotRead,
  HOT_READ_BUDGETS_MS,
  PRODUCTION_CORPUS_MESSAGE_COUNT,
  PRODUCTION_CORPUS_SIGNATURE,
  timingTable,
  type HotReadName,
  type HotReadResult,
} from './production-corpus-performance.js';
import { PgliteDatabase } from './test-support.js';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const ROOM = '20000000-0000-4000-8000-000000000001';
const CORNER = '30000000-0000-4000-8000-000000000001';
const VIEWER = 'a'.repeat(64);
const AGENT = 'b'.repeat(64);
const LIVE_MESSAGE = `corpus-message-${String(PRODUCTION_CORPUS_MESSAGE_COUNT - 1).padStart(6, '0')}`;

const matchers: ReadonlyArray<readonly [HotReadName, (sql: string) => boolean]> = [
  [
    'room-view',
    (sql) => sql.includes('WITH authorized_room AS') && sql.includes('transcript_rows AS'),
  ],
  ['room-list', (sql) => sql.includes('peer_activity_at') && sql.includes('FROM rooms r')],
  [
    'message-history',
    (sql) => sql.includes('FROM messages m JOIN identities i') && sql.includes('LIMIT 31'),
  ],
  [
    'message-live-delta',
    (sql) => sql.includes('JOIN messages message ON message.room_id=room.id AND message.id=$2'),
  ],
  [
    'presence-candidates',
    (sql) => sql.includes('WITH candidates AS MATERIALIZED') && sql.includes('evidence_token'),
  ],
  ['push-candidates', (sql) => sql.includes('WITH recent_messages AS MATERIALIZED')],
  ['corner-facts', (sql) => sql.includes('FROM rooms c LEFT JOIN corner_facts f')],
];

class HotReadDatabase implements SqlDatabase {
  readonly results = new Map<HotReadName, HotReadResult>();
  readonly pending = new Set<Promise<void>>();

  constructor(private readonly database: SqlDatabase) {}

  async query<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<QueryResult<Row>> {
    const match = matchers.find(([, matches]) => matches(sql));
    if (match && !this.results.has(match[0])) {
      const measurement = explainHotRead(this.database, match[0], sql, values).then((result) => {
        this.results.set(match[0], result);
      });
      this.pending.add(measurement);
      try {
        await measurement;
      } finally {
        this.pending.delete(measurement);
      }
    }
    return this.database.query<Row>(sql, values);
  }

  transaction<T>(work: (database: SqlDatabase) => Promise<T>): Promise<T> {
    return this.database.transaction((database) => work(new HotReadDatabase(database)));
  }
}

async function seedCorpus(database: PgliteDatabase): Promise<void> {
  await migrate(database);
  await database.query(
    `CREATE TABLE IF NOT EXISTS production_corpus_meta(signature text PRIMARY KEY)`,
  );
  const cached = await database.query<{ signature: string }>(
    `SELECT signature FROM production_corpus_meta WHERE signature=$1`,
    [PRODUCTION_CORPUS_SIGNATURE],
  );
  if (cached.rowCount) return;

  await database.query(`TRUNCATE production_corpus_meta`);
  await database.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES
       ($1,'human','Corpus Viewer','viewer'),($2,'agent','Corpus Agent','agent')
     ON CONFLICT(id) DO UPDATE SET name=excluded.name,handle=excluded.handle`,
    [VIEWER, AGENT],
  );
  await database.query(
    `INSERT INTO agents(agent_id,owner_id) VALUES($1,$2) ON CONFLICT(agent_id) DO NOTHING`,
    [AGENT, VIEWER],
  );
  await database.query(
    `INSERT INTO workspaces(id,name) VALUES($1,'Production corpus') ON CONFLICT(id) DO NOTHING`,
    [WORKSPACE],
  );
  await database.query(
    `INSERT INTO rooms(id,workspace_id,parent_id,created_by,name) VALUES
       ($1,$3,NULL,$4,'Hot Room'),($2,$3,$1,$4,'Hot Corner')
     ON CONFLICT(id) DO NOTHING`,
    [ROOM, CORNER, WORKSPACE, VIEWER],
  );
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),
       ($1,$4,$2,'owner'),($1,$4,$3,'member'),
       ($1,$5,$2,'owner'),($1,$5,$3,'member')`,
    [WORKSPACE, VIEWER, AGENT, ROOM, CORNER],
  );
  await database.query(
    `INSERT INTO corner_facts(corner_id,owner_agent_id,objective,lifecycle)
     VALUES($1,$2,'Exercise corner joins','{"lifecycle":"working","checks":"unknown"}')
     ON CONFLICT(corner_id) DO NOTHING`,
    [CORNER, AGENT],
  );
  await database.query(
    `INSERT INTO messages(id,room_id,author_id,text,created_at)
     SELECT 'corpus-message-' || lpad(series::text,6,'0'),$1,
       CASE WHEN series%7=0 THEN $2 ELSE $3 END,
       CASE WHEN series%17=0 THEN 'hello @agent' ELSE 'production corpus message ' || series END,
       now()-interval '2 days'+series*interval '1 millisecond'
     FROM generate_series(0,$4::integer-11) series
     ON CONFLICT(id) DO NOTHING`,
    [ROOM, AGENT, VIEWER, PRODUCTION_CORPUS_MESSAGE_COUNT],
  );
  await database.query(
    `INSERT INTO messages(id,room_id,author_id,text,created_at)
     SELECT 'corpus-message-' || lpad(series::text,6,'0'),$1,$2,'fresh @agent ' || series,
       now()-interval '1 minute'+(series-$3::integer+10)*interval '1 second'
     FROM generate_series($3::integer-10,$3::integer-1) series
     ON CONFLICT(id) DO NOTHING`,
    [ROOM, VIEWER, PRODUCTION_CORPUS_MESSAGE_COUNT],
  );
  await database.query(
    `INSERT INTO messages(id,room_id,author_id,text,created_at)
     VALUES('corner-message',$1,$2,'corner update',now()) ON CONFLICT(id) DO NOTHING`,
    [CORNER, AGENT],
  );
  await database.query(
    `INSERT INTO live_outputs(agent_id,room_id,turn_id,kind,body,updated_at)
     VALUES($1,$2,'presence','presence','{"status":"online","observedAt":1,"lifecycleId":"corpus"}',now()-interval '2 minutes')
     ON CONFLICT(room_id,agent_id,turn_id,kind)
     DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at`,
    [AGENT, ROOM],
  );
  await database.query(
    `INSERT INTO push_devices(token,identity_id,platform,environment,registered_at)
     VALUES('corpus-device',$1,'android','physical',now()-interval '1 day') ON CONFLICT(token) DO NOTHING`,
    [AGENT],
  );
  await database.query(
    `INSERT INTO push_delivery_floors(id,started_at) VALUES('message-delivery',now()-interval '1 day')
     ON CONFLICT(id) DO UPDATE SET started_at=excluded.started_at`,
  );
  await database.query(`ANALYZE`);
  await database.query(`INSERT INTO production_corpus_meta(signature) VALUES($1)`, [
    PRODUCTION_CORPUS_SIGNATURE,
  ]);
}

describe('PRODUCTION-CORPUS REPLAY hot-read gate', () => {
  let database: PgliteDatabase;

  beforeAll(async () => {
    const cacheDirectory = process.env.PRODUCTION_CORPUS_CACHE_DIR;
    if (cacheDirectory) await mkdir(cacheDirectory, { recursive: true });
    database = new PgliteDatabase(
      new PGlite(cacheDirectory ? `file://${cacheDirectory}` : undefined),
    );
    await seedCorpus(database);
    const count = await database.query<{ count: string }>(
      `SELECT count(*)::text count FROM messages`,
    );
    expect(Number(count.rows[0]?.count)).toBeGreaterThanOrEqual(PRODUCTION_CORPUS_MESSAGE_COUNT);
  }, 120_000);

  afterAll(async () => database.close());

  it('times every production hot read and rejects unsafe plans', async () => {
    const measured = new HotReadDatabase(database);
    const phone = new PhoneService(measured, 'https://server.usebeeline.app');
    const live = new LiveHub();
    const presence = new ConnectionPresence(measured, live);
    const push = new PushDeliveryLoop(measured, { send: async () => {} });

    await phone.readRoom(ROOM, VIEWER);
    await phone.readChats(WORKSPACE, VIEWER);
    await phone.readHistory(ROOM, VIEWER);
    await phone.readLiveDelta(ROOM, VIEWER, { type: 'message', messageId: LIVE_MESSAGE });
    await phone.readCorners(ROOM, VIEWER);
    await presence.observe(ROOM);
    await presence.stop();
    await push.runOnce();
    await Promise.all(measured.pending);

    expect([...measured.results.keys()].sort()).toEqual(Object.keys(HOT_READ_BUDGETS_MS).sort());
    const results = [...measured.results.values()];
    const planDirectory = process.env.PRODUCTION_CORPUS_PLAN_DIR;
    if (planDirectory) {
      await mkdir(planDirectory, { recursive: true });
      await Promise.all(
        results.map((result) =>
          writeFile(`${planDirectory}/${result.name}.json`, `${JSON.stringify(result, null, 2)}\n`),
        ),
      );
    }
    console.info(`\nPRODUCTION-CORPUS REPLAY timings\n${timingTable(results)}`);
  }, 120_000);

  it('turns red for the #1120 correlated per-message tag shape and prints its plan', async () => {
    const explained = await database.query<QueryResultRow>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
       SELECT message.id,ARRAY(
         SELECT member.identity_id FROM memberships member
         WHERE member.room_id=message.room_id AND member.removed_at IS NULL
       ) tagged_ids
       FROM messages message`,
    );
    const plan = explained.rows[0]?.['QUERY PLAN'];
    const runGate = () =>
      assertHotRead({
        name: 'room-view',
        budgetMs: HOT_READ_BUDGETS_MS['room-view'],
        p95Ms: 1,
        samples: [{ plan, wallMs: 1 }],
      });
    // This switch is the reproducible red proof used in the PR. Normal CI
    // asserts that the same failure is caught without intentionally failing.
    if (process.env.REPRODUCE_1120 === '1') runGate();
    expect(runGate).toThrow(/per-row correlated subquery[\s\S]*Offending EXPLAIN/);
  }, 30_000);
});
