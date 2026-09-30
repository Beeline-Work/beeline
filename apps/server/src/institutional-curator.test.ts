import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, migrateData } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { runInstitutionalCuratorCycle } from './institutional-curator.js';

const WORKSPACE = '10000000-0000-4000-8000-000000000301';
const ROOM = '20000000-0000-4000-8000-000000000301';
const HUMAN = 'a'.repeat(64);
const AGENT = 'b'.repeat(64);
const MESSAGE = 'curator-source-message';
const NOW = new Date('2026-09-28T12:00:00Z');
const config = { enabled: true, live: true } as const;
let database: PgliteDatabase;

beforeEach(async () => {
  database = new PgliteDatabase();
  await migrate(database);
  await database.query(`INSERT INTO identities(id,kind,name) VALUES($1,'human','Human'),($2,'agent','Bee')`, [HUMAN, AGENT]);
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Memory')`, [WORKSPACE]);
  await database.query(`INSERT INTO agents(agent_id,owner_id,machine_id) VALUES($1,$2,'host-1')`, [AGENT, HUMAN]);
  await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Shared')`, [ROOM, WORKSPACE]);
  await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
    ($1,NULL,$2,'owner'),($1,NULL,$3,'member'),($1,$4,$2,'owner'),($1,$4,$3,'member')`,
    [WORKSPACE, HUMAN, AGENT, ROOM]);
  await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'A durable source')`, [MESSAGE, ROOM, HUMAN]);
  await database.query(`INSERT INTO institutional_memory_workspace_rollouts
    (workspace_id,stage,availability_observed_at) VALUES($1,'live',$2)`, [WORKSPACE, NOW]);
});
afterEach(async () => { await database.close(); });

async function item(id: string, ageDays: number, explicit: boolean): Promise<void> {
  await database.query(`INSERT INTO institutional_memory_items
    (id,workspace_id,kind,canonical_key,body,state,source_room_id,source_message_id,
     audience_kind,confidence,version,explicit_save,updated_at)
    VALUES($1,$2,'workspace_fact',$3,$4,'active',$5,$6,'workspace',0.9,1,$7,$8::timestamptz-$9*interval '1 day')`,
    [id, WORKSPACE, `key-${id.slice(-4)}`, `Fact ${id.slice(-4)}`, ROOM, MESSAGE, explicit, NOW, ageDays]);
}

it('expires reviewer saves after 90 days and explicit saves after 365, blanking text and retaining rows', async () => {
  const reviewer = '30000000-0000-4000-8000-000000000301';
  const explicitYoung = '30000000-0000-4000-8000-000000000302';
  const explicitOld = '30000000-0000-4000-8000-000000000303';
  await item(reviewer, 91, false);
  await item(explicitYoung, 91, true);
  await item(explicitOld, 366, true);
  expect(await runInstitutionalCuratorCycle(database, config, NOW)).toBe(0);
  const rows = (await database.query<{ id: string; state: string; body: string; deleted_at: Date | null }>(
    `SELECT id,state,body,deleted_at FROM institutional_memory_items WHERE id=ANY($1::uuid[]) ORDER BY id`,
    [[reviewer, explicitYoung, explicitOld]],
  )).rows;
  expect(rows.map(({ state, body, deleted_at }) => [state, body, Boolean(deleted_at)])).toEqual([
    ['stale', '', true], ['active', 'Fact 0302', false], ['stale', '', true],
  ]);
  expect((await database.query(`SELECT 1 FROM institutional_memory_jobs WHERE trigger_kind='curator'`)).rowCount).toBe(0);
});

it('marks queued curator jobs dead during migration and backfills explicit-save provenance', async () => {
  const saved = '30000000-0000-4000-8000-000000000304';
  await database.query(`INSERT INTO institutional_memory_items
    (id,workspace_id,kind,canonical_key,body,source_room_id,source_message_id,
     audience_kind,confidence,version,created_by_command_id)
    VALUES($1,$2,'workspace_fact','old-explicit','An explicit fact',$3,$4,'workspace',0.9,1,'command')`,
    [saved, WORKSPACE, ROOM, MESSAGE]);
  await database.query(`INSERT INTO institutional_memory_jobs
    (id,workspace_id,trigger_kind,mode,source_room_id,source_message_id,
     requester_identity_id,source_audience_kind,idempotency_key)
    VALUES($1,$2,'curator','live',$3,$4,$5,'workspace_candidate','old-curator')`,
    ['50000000-0000-4000-8000-000000000301', WORKSPACE, ROOM, MESSAGE, HUMAN]);
  await migrateData(database);
  expect((await database.query<{ explicit_save: boolean }>(
    `SELECT explicit_save FROM institutional_memory_items WHERE id=$1`, [saved])).rows[0]?.explicit_save).toBe(true);
  expect((await database.query<{ status: string; error: string }>(
    `SELECT status,error FROM institutional_memory_jobs WHERE id=$1`,
    ['50000000-0000-4000-8000-000000000301'])).rows[0]).toMatchObject({
      status: 'dead', error: 'curator model jobs removed',
    });
});
