import { cornerReportWaiting } from './corner-state.js';

import { cornerWaitingReportSql } from './corner-waiting-report.js';


import { cornerIdleSql } from './corner-idle.js';

import { cornerOwedAnswerTimesSql } from './corner-owed.js';

import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

import { systemLine } from './system-line.js';

import { cornerOwedSchemaSql } from './corner-owed.js';

import { migrate, PostgresDatabase, type SqlDatabase } from './database.js';

import { Pool } from 'pg';

import { randomUUID } from 'node:crypto';

import { seedCornerOpening, PgliteDatabase, recordCornerRun, insertCornerFacts } from './test-support.js';

import { HelperDaemonService as DaemonService } from './test-fixtures/helper-daemon.js';

import { PhoneService } from './phone-service.js';

import { LiveHub } from './live.js';

import { createAgentCommand, readAgentCommands } from './agent-command.js';

import {
  CORNER_ATTENTION_SCHEMA,
  refreshCornerAttention,
  CornerAttentionDeadlines,
  runCornerAttention,
} from './corner-attention.js';


export const WS = '11111111-1111-4111-8111-111111111111',
  ROOM = '22222222-2222-4222-8222-222222222222';

export const C = '33333333-3333-4333-8333-333333333333';

export const HUMAN = 'a'.repeat(64),
  COMMANDER = 'b'.repeat(64),
  WORKER = 'c'.repeat(64),
  REVIEWER = 'd'.repeat(64);

export let db: SqlDatabase, closeDatabase: () => Promise<void>, daemon: DaemonService, phone: PhoneService;

beforeAll(async () => {
  if (process.env.BEELINE_ATTENTION_TEST_POSTGRES_URL) {
    const url = process.env.BEELINE_ATTENTION_TEST_POSTGRES_URL;
    const schema = `attention_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pg = new PostgresDatabase('', 5, { pool: new Pool({ connectionString: url,
      options: `-c search_path=${schema},public` }), mode: 'migration' });
    db = pg;
    closeDatabase = async () => { await pg.close(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); };
  } else {
    const pg = new PgliteDatabase(); db = pg; closeDatabase = () => pg.close();
  }
  await migrate(db);
  await db.query(
    `INSERT INTO identities(id,kind,name,handle) VALUES
    ($1,'human','Owner','owner'),($2,'agent','Commander','commander'),
    ($3,'agent','Worker','worker'),($4,'agent','Reviewer','reviewer')`,
    [HUMAN, COMMANDER, WORKER, REVIEWER],
  );
  await db.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$4),($2,$4),($3,$4)`, [
    COMMANDER,
    WORKER,
    REVIEWER,
    HUMAN,
  ]);
  daemon = new DaemonService(db, new LiveHub());
  phone = new PhoneService(db, 'http://test');
}, 30_000);

afterAll(async () => closeDatabase());

beforeEach(async () => {
  await db.query('DELETE FROM workspaces');
  await db.query('DELETE FROM agent_connections');
  await db.query('DELETE FROM agent_startup_backoff');

  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Truthful states')`, [WS]);
  await db.query(
    `INSERT INTO rooms(id,workspace_id,name,created_by,reviewer_agent_id) VALUES($1,$2,'Room',$3,$4)`,
    [ROOM, WS, HUMAN, REVIEWER],
  );
  for (const identity of [HUMAN, COMMANDER, WORKER, REVIEWER])
    await db.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role)
    VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`,
      [WS, identity, ROOM],
    );
  await db.query(
    `INSERT INTO rooms(id,workspace_id,parent_id,name,created_by) VALUES($1,$2,$3,'Corner',$4)`,
    [C, WS, ROOM, COMMANDER],
  );
  await insertCornerFacts(db, { cornerId: C, ownerAgentId: WORKER, commissionedBy: HUMAN, workerAgentId: WORKER });
  await createAgentCommand(db, {
    id: 'opening-order',
    roomId: C,
    agentId: WORKER,
    sourceMessageId: null,
    reason: 'order',
    privatePayload: { kind: 'order', text: 'Do the work', authorId: COMMANDER, fromRoomId: ROOM },
  });
  await db.query(`UPDATE agent_commands SET state='complete' WHERE id='opening-order'`);
  await db.query(`DELETE FROM agent_turns WHERE room_id=$1`,[C]);
  await db.query("UPDATE rooms SET created_at=now()-interval '1 day' WHERE id=$1", [C]);
});

export const state = async () =>
  (await daemon.execute('getCornerRestoreState', { cornerId: C }, WORKER)).state;

export const wake = async (agentId = WORKER, id = 'new-work') =>
  createAgentCommand(db, {
    id,
    roomId: C,
    agentId,
    sourceMessageId: null,
    reason: 'order',
    privatePayload: { kind: 'order', text: 'Continue', authorId: COMMANDER, fromRoomId: ROOM },
  });

export const post = async (id: string, text: string, author = WORKER, age = '0 hours') =>
  db.query(
    `INSERT INTO messages(id,room_id,author_id,text,presentation,created_at)
  VALUES($1,$2,$3,$4,'message',now()-$5::interval)`,
    [id, C, author, text, age],
  );

// The idle alert now wakes its opening commander inside the corner whenever
// the commander has effective access (inherited parent-roster access counts).
export const commanderFlags = async () => (await readAgentCommands(db, C, COMMANDER)).commands;


export async function turn(agent = WORKER) {
  let command=agent===COMMANDER?undefined:(await readAgentCommands(db,C,agent)).commands[0];
  if(!command) {
    const queued=(await wake(agent,randomUUID()))!;
    command=(await readAgentCommands(db,C,agent)).commands.find(item=>item.id===queued.id)!;
  }
  await daemon.execute('claimAgentCommand',{roomId:C,commandId:command.id,generationId:'actual'},agent);
}

export async function end(agent = WORKER, age = 0) {
  await db.query(`SELECT beeline_end_agent_turn(id,generation_id,'complete') FROM agent_commands
    WHERE room_id=$1 AND agent_id=$2 AND state='claimed'`,[C,agent]);
  await db.query(`UPDATE agent_turns SET ended_at=clock_timestamp()-make_interval(secs=>$2)
    WHERE room_id=$1 AND status<>'working' AND agent_id=$3`,[C,age,agent]);
}

export async function ci(checks: string) {
  await db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
    C,
    JSON.stringify({
      lifecycle: 'in-review',
      checks,
      pr: { number: 1, url: 'https://github.com/o/r/pull/1', headSha: 'head' },
      checksSummary: {
        status: checks,
        total: 1,
        updatedAt: Date.now() / 1000,
        checks: [
          {
            name: 'tests',
            status: checks === 'pending' ? 'pending' : 'failed',
            url: 'https://github.com/o/r/actions/runs/1',
          },
        ],
        failing: [],
      },
    }),
  ]);
}

export async function unreportedHead() {
  await db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
    C,
    JSON.stringify({
      lifecycle: 'in-review',
      checks: 'unknown',
      pr: { number: 1, url: 'https://github.com/o/r/pull/1', headSha: 'head', title: 'Fix', targetBranch: 'main' },
      checksSummary: { status: 'unknown', total: 0, failing: [], checks: [], updatedAt: Date.now() / 1000 },
    }),
  ]);
}


export async function checksHead(sha: string, checks: 'pending' | 'failing') {
  await db.query(`UPDATE corner_github_cache SET lifecycle=$2::jsonb WHERE corner_id=$1`, [
    C,
    JSON.stringify({
      lifecycle: 'in-review',
      checks,
      pr: { number: 2890, url: 'https://github.com/o/r/pull/2890', headSha: sha },
      checksSummary: {
        status: checks,
        total: 34,
        updatedAt: Date.now() / 1000,
        checks: [{
          name: 'SERVER SUITE',
          status: checks === 'pending' ? 'pending' : 'failed',
          url: 'https://github.com/o/r/actions/runs/1',
        }],
        failing: checks === 'failing' ? ['SERVER SUITE'] : [],
      },
    }),
  ]);
}
export const rootFixture = {
get db(){return db;}, set db(value: typeof db){db=value;},
get closeDatabase(){return closeDatabase;}, set closeDatabase(value: typeof closeDatabase){closeDatabase=value;},
get daemon(){return daemon;}, set daemon(value: typeof daemon){daemon=value;},
get phone(){return phone;}, set phone(value: typeof phone){phone=value;},
};

export { cornerReportWaiting } from './corner-state.js';
export { cornerWaitingReportSql } from './corner-waiting-report.js';
export { cornerIdleSql } from './corner-idle.js';
export { cornerOwedAnswerTimesSql, cornerOwedSchemaSql } from './corner-owed.js';
export { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
export { systemLine } from './system-line.js';
export { migrate, PostgresDatabase } from './database.js';
export { Pool } from 'pg';
export { randomUUID } from 'node:crypto';
export { seedCornerOpening, PgliteDatabase, recordCornerRun, insertCornerFacts } from './test-support.js';
export { HelperDaemonService as DaemonService } from './test-fixtures/helper-daemon.js';
export { PhoneService } from './phone-service.js';
export { LiveHub } from './live.js';
export { createAgentCommand, readAgentCommands } from './agent-command.js';
export { CORNER_ATTENTION_SCHEMA, refreshCornerAttention, CornerAttentionDeadlines, runCornerAttention } from './corner-attention.js';
export type { SqlDatabase } from './database.js';
