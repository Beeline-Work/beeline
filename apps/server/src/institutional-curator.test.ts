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

it('expires agent saves after 90 unused days, blanking text and retaining rows, and never expires explicit saves', async () => {
  const reviewer = '30000000-0000-4000-8000-000000000301';
  const explicitYoung = '30000000-0000-4000-8000-000000000302';
  const explicitOld = '30000000-0000-4000-8000-000000000303';
  await item(reviewer, 91, false);
  await item(explicitYoung, 91, true);
  await item(explicitOld, 3000, true);
  // The old per-Workspace explicit limit no longer applies.
  await database.query(`UPDATE institutional_memory_workspace_rollouts
    SET explicit_expire_after_days=1 WHERE workspace_id=$1`, [WORKSPACE]);
  expect(await runInstitutionalCuratorCycle(database, config, NOW)).toBe(0);
  const rows = (await database.query<{ id: string; state: string; body: string; deleted_at: Date | null }>(
    `SELECT id,state,body,deleted_at FROM institutional_memory_items WHERE id=ANY($1::uuid[]) ORDER BY id`,
    [[reviewer, explicitYoung, explicitOld]],
  )).rows;
  expect(rows.map(({ state, body, deleted_at }) => [state, body, Boolean(deleted_at)])).toEqual([
    ['stale', '', true], ['active', 'Fact 0302', false], ['active', 'Fact 0303', false],
  ]);
  expect((await database.query(`SELECT 1 FROM institutional_memory_jobs WHERE trigger_kind='curator'`)).rowCount).toBe(0);
});

it('never expires skills or workflows, however long they go unused', async () => {
  const skills = [
    ['40000000-0000-4000-8000-000000000301', 'old-procedure', 'procedure'],
    ['40000000-0000-4000-8000-000000000302', 'old-workflow', 'workflow'],
  ] as const;
  for (const [id, slug, kind] of skills) {
    await database.query(`INSERT INTO workspace_skills
      (id,workspace_id,slug,description,state,current_version,revision,source_room_id,
       repository,target_commit,path,kind,updated_at)
      VALUES($1,$2,$3,'Unused for a long time','active',1,1,$4,'','',NULL,$5,
        $6::timestamptz-interval '400 days')`,
      [id, WORKSPACE, slug, ROOM, kind, NOW]);
    await database.query(`INSERT INTO workspace_skill_versions
      (skill_id,version,markdown,content_hash,source_job_id,source_message_ids,
       repository,target_commit,path,extractor_version,model)
      VALUES($1,1,$2,$3,NULL,ARRAY[$4],'','',NULL,'save-v1','n/a')`,
      [id, `# ${slug}`, 'b'.repeat(64), MESSAGE]);
  }
  await runInstitutionalCuratorCycle(database, config, NOW);
  expect((await database.query<{ state: string; markdown: string }>(
    `SELECT skill.state,version.markdown FROM workspace_skills skill
     JOIN workspace_skill_versions version ON version.skill_id=skill.id
     WHERE skill.id=ANY($1::uuid[]) ORDER BY skill.id`,
    [skills.map(([id]) => id)],
  )).rows).toEqual([
    { state: 'active', markdown: '# old-procedure' },
    { state: 'active', markdown: '# old-workflow' },
  ]);
});

it('restores items the old curator only aged out, and blanks what was replaced', async () => {
  const aged = '30000000-0000-4000-8000-000000000311';
  const archived = '30000000-0000-4000-8000-000000000312';
  const replaced = '30000000-0000-4000-8000-000000000313';
  const successor = '30000000-0000-4000-8000-000000000314';
  const shadowed = '30000000-0000-4000-8000-000000000315';
  const current = '30000000-0000-4000-8000-000000000316';
  const rows: [string, string, string, string | null][] = [
    [aged, 'aged', 'stale', null],
    [archived, 'archived', 'archived', null],
    [replaced, 'replaced', 'stale', null],
    [successor, 'replaced', 'active', replaced],
    [shadowed, 'shadowed', 'stale', null],
    [current, 'shadowed', 'active', null],
  ];
  for (const [id, key, state, supersedes] of rows) {
    await database.query(`INSERT INTO institutional_memory_items
      (id,workspace_id,kind,canonical_key,body,state,source_room_id,source_message_id,
       audience_kind,confidence,version,supersedes_id,explicit_save)
      VALUES($1,$2,'workspace_fact',$3,$4,$5,$6,$7,'workspace',0.9,1,$8,true)`,
      [id, WORKSPACE, key, `Fact ${id.slice(-2)}`, state, ROOM, MESSAGE, supersedes]);
  }
  await migrateData(database);
  const states = (await database.query<{ id: string; state: string; body: string }>(
    `SELECT id,state,body FROM institutional_memory_items WHERE id=ANY($1::uuid[]) ORDER BY id`,
    [rows.map(([id]) => id)],
  )).rows;
  expect(states.map(({ state, body }) => [state, body])).toEqual([
    ['active', 'Fact 11'],
    ['active', 'Fact 12'],
    ['stale', ''],
    ['active', 'Fact 14'],
    ['stale', ''],
    ['active', 'Fact 16'],
  ]);
});

it('marks every unfinished curator job dead during migration and backfills explicit-save provenance', async () => {
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
  await database.query(`INSERT INTO institutional_memory_jobs
    (id,workspace_id,trigger_kind,mode,source_room_id,source_message_id,
     requester_identity_id,source_audience_kind,idempotency_key,status,lease_owner_agent_id,
     lease_owner_machine_id,lease_token,lease_expires_at)
    VALUES($1,$2,'curator','live',$3,$4,$5,'workspace_candidate','claimed-curator',
      'claimed',$6,'host-1','lease',now()+interval '1 hour')`,
    ['50000000-0000-4000-8000-000000000302', WORKSPACE, ROOM, MESSAGE, HUMAN, AGENT]);
  await migrateData(database);
  expect((await database.query<{ explicit_save: boolean }>(
    `SELECT explicit_save FROM institutional_memory_items WHERE id=$1`, [saved])).rows[0]?.explicit_save).toBe(true);
  expect((await database.query<{ status: string; error: string }>(
    `SELECT status,error FROM institutional_memory_jobs WHERE id=ANY($1::uuid[]) ORDER BY id`,
    [['50000000-0000-4000-8000-000000000301', '50000000-0000-4000-8000-000000000302']])).rows)
    .toEqual([
      { status: 'dead', error: 'curator model jobs removed' },
      { status: 'dead', error: 'curator model jobs removed' },
    ]);
});
