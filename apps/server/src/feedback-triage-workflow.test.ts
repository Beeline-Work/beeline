import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWorkflowContract, validateSavedWorkflow } from '@beeline/api-contract/daemon';
import type { CommandRow } from './agent-command.js';
import type { SqlDatabase } from './database.js';
import { migrate, migrateData } from './database.js';
import { workflowBackfillOnce } from './migrations/workflow-cleanup.js';
import {
  FEEDBACK_TRIAGE_CONTRACT,
  WORKSPACE_WALK_CONTRACT,
  backfillFeedbackSignalWalk,
  backfillWorkspaceWalkHistory,
  WORKSPACE_WALK_STEPS,
  FEEDBACK_TRIAGE_SCHEDULE_PROMPT,
  FEEDBACK_TRIAGE_STEPS,
  backfillFeedbackTriageWorkflow,
} from './feedback-triage-workflow.js';
import { getInstitutionalContext } from './institutional-memory-shadow.js';
import { loadWorkspaceSkill } from './institutional-skills.js';
import { PgliteDatabase } from './test-support.js';
import { completeServiceReview, readServiceReviewPage } from './service-review.js';
import { handoff, startWorkflow, saveWorkflow } from './workflow-runs.js';

const WORKSPACE = '10000000-0000-4000-8000-000000000301';
const OTHER_WORKSPACE = '10000000-0000-4000-8000-000000000302';
const ROOM = '20000000-0000-4000-8000-000000000301';
const TRIAGE_CORNER = '20000000-0000-4000-8000-000000000302';
const OTHER_ROOM = '20000000-0000-4000-8000-000000000303';
const CREATOR = 'a'.repeat(64);
const TRIAGER = 'c'.repeat(64);
const TRIAGE_SCHEDULE = '7d7fa17b-0000-4000-8000-000000000001';
const SWEEP_SCHEDULE = '30000000-0000-4000-8000-000000000002';
const UNRELATED_SCHEDULE = '30000000-0000-4000-8000-000000000003';
const OLD_SWEEP_PROMPT =
  'Run the Beeline feedback sweep. Call `list_feedback`, then `get_feedback` on the items you will act on.';
const DAILY = { kind: 'cron', expression: '0 14 * * *', timeZone: 'UTC' };

let database: PgliteDatabase;

beforeEach(async () => {
  database = new PgliteDatabase();
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name) VALUES($1,'human','Creator'),($2,'agent','Triager')`,
    [CREATOR, TRIAGER],
  );
  await database.query(`INSERT INTO agents(agent_id,owner_id,harness,selected_model) VALUES($1,$2,'claude','default')`, [TRIAGER, CREATOR]);
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Beeline'),($2,'Other')`, [
    WORKSPACE,
    OTHER_WORKSPACE,
  ]);
  await database.query(
    `INSERT INTO institutional_memory_workspace_rollouts(workspace_id,stage) VALUES($1,'live')`,
    [WORKSPACE],
  );
  await database.query(
    `INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Product'),($3,$4,'Elsewhere')`,
    [ROOM, WORKSPACE, OTHER_ROOM, OTHER_WORKSPACE],
  );
  await database.query(
    `INSERT INTO rooms(id,workspace_id,parent_id,name) VALUES($1,$2,$3,'Issues triage')`,
    [TRIAGE_CORNER, WORKSPACE, ROOM],
  );
  for (const roomId of [ROOM])
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner'),($1,$2,$4,'member')`,
      [WORKSPACE, roomId, CREATOR, TRIAGER],
    );
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,NULL,$3,'member')`,
    [WORKSPACE, CREATOR, TRIAGER],
  );
  const schedule = (id: string, workspaceId: string, roomId: string, message: string) =>
    database.query(
      `INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,'2026-10-02T14:00:00Z')`,
      [id, workspaceId, roomId, TRIAGER, CREATOR, JSON.stringify(DAILY), message],
    );
  // The triage corner's own schedule, whatever its prompt said.
  await schedule(TRIAGE_SCHEDULE, WORKSPACE, TRIAGE_CORNER, 'Daily sweep of new reports.');
  // Another Workspace's schedule written for the retired tools.
  await schedule(SWEEP_SCHEDULE, OTHER_WORKSPACE, OTHER_ROOM, OLD_SWEEP_PROMPT);
  await schedule(UNRELATED_SCHEDULE, WORKSPACE, ROOM, 'Post the standup summary.');
});

afterEach(async () => {
  await database.close();
});

async function schedules() {
  return (
    await database.query<{ id: string; message: string; cadence: unknown; next_run_at: Date }>(
      `SELECT id,message,cadence,next_run_at FROM agent_schedules ORDER BY id`,
    )
  ).rows;
}

async function skills(workspaceId = WORKSPACE) {
  return (
    await database.query<{ slug: string; kind: string; current_version: number }>(
      `SELECT slug,kind,current_version FROM workspace_skills WHERE workspace_id=$1 ORDER BY slug`,
      [workspaceId],
    )
  ).rows;
}

function cornerTurn(messageId: string): CommandRow {
  return {
    id: 'triage-command',
    room_id: TRIAGE_CORNER,
    agent_id: TRIAGER,
    source_message_id: messageId,
    turn_request_id: 'triage-request',
    action: 'input',
    reason: 'schedule',
    root_command_id: 'triage-command',
    parent_command_id: null,
    root_source_message_id: messageId,
    agent_depth: 0,
    state: 'claimed',
    generation_id: 'generation-1',
    lease_expires_at: new Date(Date.now() + 60_000),
    result_message_id: null,
    hiccup_attempts: 0,
    lifecycle_before: null,
    restart_confirmed_at: null,
  };
}

describe('feedback-triage workflow', () => {
  it.each([1,14] as const)('walk-history: scheduled kickoff selects a %s-day window and SQL pages expose authors', async (days) => {
    await database.query(`INSERT INTO messages(id,room_id,author_id,text,created_at)
      VALUES('historical-person',$1,$2,'Synthetic history',now()-interval '10 days'),
            ('historical-agent',$1,$3,'Synthetic reply',now()-interval '10 days')`,[OTHER_ROOM,CREATOR,TRIAGER]);
    await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('history-start',$1,$2,'Start walk')`,[TRIAGE_CORNER,CREATOR]);
    // Keep PostgreSQL's real clock for the history bounds; choose only the weekday branch.
    const clocked = (db: SqlDatabase): SqlDatabase => ({
      query: (sql,values) => db.query(sql.includes('extract(isodow FROM now()') ? `SELECT ${days} AS days` : sql,values),
      transaction: work => db.transaction(tx => work(clocked(tx))),
    });
    const turn=cornerTurn('history-start');
    await saveWorkflow(database,turn,{contract:WORKSPACE_WALK_CONTRACT});
    const {runId}=await startWorkflow(database,turn,{name:'workspace-walk',roleBindings:{triager:TRIAGER}});
    await handoff(clocked(database),turn,{runId,outcome:'started',contents:{}});
    const page=await readServiceReviewPage(database,TRIAGER,runId,OTHER_WORKSPACE);
    expect(page.rows).toHaveLength(days===14 ? 2 : 0);
    if (days===14) {
      expect(page.rows.find(row=>row.id==='historical-person')!.activity).toMatchObject({authorId:CREATOR,authorKind:'human',ownerId:null});
      expect(page.rows.find(row=>row.id==='historical-agent')!.activity).toMatchObject({authorId:TRIAGER,authorKind:'agent',ownerId:CREATOR});
    }
  });

  it('refreshes old server-seeded walk procedures once and preserves team edits', async () => {
    await backfillFeedbackTriageWorkflow(database);
    await backfillFeedbackSignalWalk(database);
    await database.query(`UPDATE workspace_skill_versions SET markdown='Old seed',content_hash=repeat('0',64)
      WHERE skill_id IN(SELECT id FROM workspace_skills WHERE slug='workspace-browse-sweep')`);
    await backfillWorkspaceWalkHistory(database);
    const current = async () => (await database.query<{markdown:string}>(`SELECT v.markdown FROM workspace_skills s
      JOIN workspace_skill_versions v ON v.skill_id=s.id AND v.version=s.current_version
      WHERE s.workspace_id=$1 AND s.slug='workspace-browse-sweep'`,[WORKSPACE])).rows[0]!.markdown;
    expect(await current()).toBe(WORKSPACE_WALK_STEPS);
    await database.query(`UPDATE workspace_skill_versions SET markdown='Team procedure',extractor_version='team'
      WHERE skill_id IN(SELECT id FROM workspace_skills WHERE slug='workspace-browse-sweep')`);
    await backfillWorkspaceWalkHistory(database);
    expect(await current()).toBe('Team procedure');
  });

  it('has no approval gate or dispatch state in the seeded contract', () => {
    expect(Object.values(FEEDBACK_TRIAGE_CONTRACT.handoffs).some(step => step.kind === 'gate')).toBe(false);
    expect(FEEDBACK_TRIAGE_CONTRACT.handoffs).not.toHaveProperty('approve');
    expect(FEEDBACK_TRIAGE_CONTRACT.handoffs).not.toHaveProperty('dispatch');
    expect(FEEDBACK_TRIAGE_STEPS).not.toMatch(/^## (approve|dispatch)$/m);
    expect(FEEDBACK_TRIAGE_STEPS).toContain('every earlier dispatch handoff');
    expect(FEEDBACK_TRIAGE_STEPS).toContain('do not create a new entry for each dispatched fix');
    expect(FEEDBACK_TRIAGE_STEPS).toContain('at most 10 active experiments');
    expect(FEEDBACK_TRIAGE_STEPS).not.toContain('New fix entries come from');
    expect(FEEDBACK_TRIAGE_STEPS).not.toContain('Include signals');
    expect(FEEDBACK_TRIAGE_STEPS).not.toContain('morning-card dispatch record');
  });

  it('calculates the next 07:00 in both backfills before and at the boundary in winter and summer', async () => {
    await backfillFeedbackTriageWorkflow(database);
    for (const backfill of [backfillFeedbackTriageWorkflow, backfillFeedbackSignalWalk]) {
      for (const [now, expected] of [
        ['2026-01-15T11:59:59Z', '2026-01-15T12:00:00.000Z'],
        ['2026-01-15T12:00:00Z', '2026-01-16T12:00:00.000Z'],
        ['2026-07-15T10:59:59Z', '2026-07-15T11:00:00.000Z'],
        ['2026-07-15T11:00:00Z', '2026-07-16T11:00:00.000Z'],
      ]) {
        await database.query(`UPDATE agent_schedules SET cadence=$2::jsonb WHERE id=$1`,
          [TRIAGE_SCHEDULE, JSON.stringify({...DAILY, expression:'0 10 * * *', timeZone:'America/New_York'})]);
        // Freeze SQL time while still executing the actual backfill queries in PostgreSQL.
        const atTime = (db: SqlDatabase): SqlDatabase => ({
          query: (sql, values) => db.query(sql.replace(/now\(\)/g, `TIMESTAMPTZ '${now}'`), values),
          transaction: work => db.transaction(tx => work(atTime(tx))),
        });
        await backfill(atTime(database));
        const schedule = (await schedules()).find(row => row.id === TRIAGE_SCHEDULE)!;
        expect(schedule.cadence).toEqual({kind:'cron', expression:'0 7 * * *', timeZone:'America/New_York'});
        expect(schedule.next_run_at.toISOString()).toBe(expected);
        const walks = await database.query<{cadence: unknown}>(
          `SELECT cadence FROM agent_schedules WHERE workflow_slug='workspace-walk'`);
        for (const walk of walks.rows)
          expect(walk.cadence).toEqual({kind:'cron', expression:'0 6 * * *', timeZone:'America/New_York'});
      }
    }
  });

  it.each(['presented', 'nothing_to_build'])('demonstrates the scheduled triage path ending at done after %s without a choice card', async outcome => {
    await backfillFeedbackTriageWorkflow(database);
    await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('triage-start',$1,$2,'Start triage')`,
      [TRIAGE_CORNER, CREATOR]);
    const turn = cornerTurn('triage-start');
    const {runId} = await startWorkflow(database, turn, {name:'feedback-triage',roleBindings:{triager:TRIAGER}});
    await handoff(database, turn, {runId, outcome:'notified', contents:{fixedPullRequests:[],skipReason:'none',unnotifiedPullRequests:[]}});
    await handoff(database, turn, {runId, attempt:1, outcome:'checked', contents:{signalChecks:[]}});
    await handoff(database, turn, {runId, attempt:2, outcome:'ranked', contents:{problems:[]}});
    await handoff(database, turn, {runId, attempt:3, outcome:'checked', contents:{adapterFindings:[],adapterResults:[],skipReason:'none'}});
    await expect(handoff(database, turn, {runId, attempt:4, outcome,
      contents:{rankedProblems:[],walkRunId:'completed-morning-walk'}})).resolves.toMatchObject({state:'done',status:'done'});
    expect((await database.query(`SELECT id FROM room_choices WHERE room_id=$1`, [TRIAGE_CORNER])).rows).toEqual([]);
    const start = (await database.query<{card:{runStatus:string}}>(`SELECT card FROM messages WHERE id=$1`, [runId])).rows[0]!;
    expect(start.card.runStatus).toBe('done');
  });

  it('demonstrates an uncapped daily walk and rejects missing or empty receipts before completion', async () => {
    await backfillFeedbackTriageWorkflow(database);
    await backfillFeedbackSignalWalk(database);
    const cadenceRows = await database.query<{ workflow_slug: string; cadence: unknown }>(
      `SELECT workflow_slug,cadence FROM agent_schedules WHERE room_id=$1`,[TRIAGE_CORNER]);
    expect(cadenceRows.rows.some(row => row.workflow_slug === 'workspace-walk'
      && JSON.stringify(row.cadence).includes('0 6 * * *'))).toBe(true);
    for (let n=1;n<=7;n++) {
      const workspace = `40000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
      const room = `50000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
      await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Synthetic workspace')`,[workspace]);
      await database.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Synthetic room')`,[room,workspace]);
      await database.query(`INSERT INTO messages(id,room_id,author_id,text,presentation)
        VALUES($1,$2,$3,'Synthetic request','message')`,[`walk-${n}`,room,CREATOR]);
    }
    // Reproduction walk-scope: the operator's internal traffic must never be reserved.
    await database.query(`UPDATE workspaces SET internal=true WHERE id=$1`,[WORKSPACE]);
    await database.query(`INSERT INTO messages(id,room_id,author_id,text,presentation)
      SELECT 'internal-'||n,$1,$2,'Synthetic internal traffic','message' FROM generate_series(1,29650) n`,[ROOM,CREATOR]);
    await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES('walk-start',$1,$2,'Start walk')`,[TRIAGE_CORNER,CREATOR]);
    const turn = cornerTurn('walk-start');
    await expect(saveWorkflow(database,turn,{contract:WORKSPACE_WALK_CONTRACT})).resolves.toMatchObject({slug:'workspace-walk'});
    await expect(saveWorkflow(database,turn,{contract:FEEDBACK_TRIAGE_CONTRACT})).resolves.toMatchObject({slug:'feedback-triage'});
    const { runId } = await startWorkflow(database,turn,{name:'workspace-walk',roleBindings:{triager:TRIAGER}});
    await handoff(database,turn,{runId,outcome:'started',contents:{}});
    const targets = await database.query<{workspace_id:string}>('SELECT * FROM service_review_targets($1,$2)',[TRIAGER,runId]);
    expect(targets.rows).toHaveLength(7);
    expect(targets.rows.map(row=>row.workspace_id)).not.toContain(WORKSPACE);
    expect((await readServiceReviewPage(database,TRIAGER,runId,WORKSPACE)).rows).toEqual([]);
    await expect(handoff(database,turn,{runId,outcome:'reviewed',attempt:1,contents:{receipts:[],findings:[]}}))
      .rejects.toThrow('receipt is required');
    const receipts = [];
    for (const target of targets.rows) {
      let after = '';
      let rowsRead = 0;
      const times: string[] = [];
      for (;;) {
        const page = await readServiceReviewPage(database,TRIAGER,runId,target.workspace_id,after);
        if (!page.rows.length) break;
        rowsRead += page.rows.length;
        for (const row of page.rows) {
          const activity = row.activity as {rowKind:string;createdAt:string};
          if (activity.rowKind === 'message') times.push(new Date(activity.createdAt).toISOString());
        }
        after = page.rows.at(-1)!.id;
      }
      times.sort();
      receipts.push({workspace:target.workspace_id,rowsRead,firstMessageTime:times[0]??null,lastMessageTime:times.at(-1)??null,findings:'none'});
    }
    await expect(handoff(database,turn,{runId,outcome:'reviewed',attempt:1,
      contents:{receipts:receipts.map(row=>({...row,rowsRead:0})),findings:[]}})).rejects.toThrow('receipt must match');
    await expect(handoff(database,turn,{runId,outcome:'reviewed',attempt:1,contents:{receipts,findings:[]}}))
      .resolves.toMatchObject({state:'done',status:'done'});
    const completed = await database.query('SELECT * FROM service_review_visits WHERE run_id=$1 AND completed_at IS NOT NULL',[runId]);
    expect(completed.rows).toHaveLength(targets.rows.length);
    console.log(`Demonstrated walk-scope: internal traffic excluded; ${targets.rows.length} active workspaces fully read; incomplete receipts refused`);
  }, 60_000);

  it('Reproduction SR18: accepts all message extrema and commits workspace cursors atomically', async () => {
    const runId = 'isolated-sr18';
    await database.query(`INSERT INTO service_review_visits(workspace_id,agent_id,run_id,read_from,read_through)
      SELECT id,$1,$2,'2026-01-01T00:00:00Z','2026-01-02T00:00:00Z' FROM workspaces`, [TRIAGER,runId]);
    const first = '2026-01-01T02:00:00.000Z';
    const last = '2026-01-01T22:00:00.000Z';
    const toolActivity = [{type:'tool',name:'synthetic-tool'}];
    for (const [id,room,time,activity] of [
      ['sr18-first',ROOM,first,toolActivity],
      ['sr18-middle',ROOM,'2026-01-01T12:00:00.000Z',{detail:'preserved',rowKind:'turn',createdAt:'wrong'}],
      ['sr18-last',ROOM,last,toolActivity],
      ['sr18-other',OTHER_ROOM,first,null],
    ] as const) {
      await database.query(`INSERT INTO messages(id,room_id,author_id,text,created_at,activity)
        VALUES($1,$2,$3,'Synthetic SR18 fixture',$4,$5::jsonb)`, [id,room,CREATOR,time,JSON.stringify(activity)]);
    }
    for (const [request,time] of [['early','2026-01-01T01:00:00Z'],['late','2026-01-01T23:00:00Z']]) {
      await database.query(`INSERT INTO agent_turns(room_id,request_id,agent_id,status,started_at)
        VALUES($1,$2,$3,'complete',$4)`, [ROOM,request,TRIAGER,time]);
    }
    const receipts = [
      {workspace:WORKSPACE,rowsRead:5,firstMessageTime:first,lastMessageTime:last,findings:'none'},
      {workspace:OTHER_WORKSPACE,rowsRead:1,firstMessageTime:first,lastMessageTime:first,findings:'none'},
    ];
    const visits = () => database.query<{completed_at:unknown;receipt:unknown}>(
      'SELECT completed_at,receipt FROM service_review_visits WHERE run_id=$1',[runId]);
    // Whichever target is visited first, its update must roll back when the next receipt fails.
    const targets = await database.query<{workspace_id:string}>('SELECT * FROM service_review_targets($1,$2)',[TRIAGER,runId]);
    const invalidWorkspace = targets.rows.at(-1)!.workspace_id;
    for (const wrong of [{rowsRead:0},{firstMessageTime:'2026-01-01T01:00:00.000Z'},{lastMessageTime:'2026-01-01T23:00:00.000Z'}]) {
      await expect(completeServiceReview(database,TRIAGER,runId,
        receipts.map(receipt => receipt.workspace === invalidWorkspace ? {...receipt,...wrong} : receipt)))
        .rejects.toThrow('receipt must match');
      expect((await visits()).rows.every(row => row.completed_at === null && row.receipt === null)).toBe(true);
    }
    await expect(completeServiceReview(database,TRIAGER,runId,receipts)).resolves.toBeUndefined();
    const page = await readServiceReviewPage(database,TRIAGER,runId,WORKSPACE);
    expect(page.rows.find(row => row.id === 'sr18-first')!.activity).toMatchObject({
      activity:toolActivity,rowKind:'message',createdAt:expect.any(String),
    });
    expect(page.rows.find(row => row.id === 'sr18-middle')!.activity).toMatchObject({detail:'preserved',rowKind:'message'});
    expect((await visits()).rows.every(row => row.completed_at !== null && row.receipt !== null)).toBe(true);
    console.log('Demonstrated SR18: array and object messages accepted; turn extrema and incorrect coverage rejected; all cursors committed together');
  });

  it('does no seed or description writes on the second migration startup', async () => {
    // Model an upgrade: fixtures predate the newly introduced markers.
    await database.query(`DELETE FROM workflow_backfills`);
    await migrateData(database);
    expect(await skills()).toHaveLength(4);
    const before = (await database.query(`SELECT * FROM workspace_skill_versions ORDER BY skill_id,version`)).rows;
    await database.query(`
      CREATE FUNCTION forbid_backfill_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'repeated workflow backfill write'; END $$;
      CREATE TRIGGER forbid_skill_backfill BEFORE INSERT OR UPDATE ON workspace_skill_versions
        FOR EACH ROW EXECUTE FUNCTION forbid_backfill_write();
      CREATE TRIGGER forbid_schedule_backfill BEFORE UPDATE ON agent_schedules
        FOR EACH ROW EXECUTE FUNCTION forbid_backfill_write();
    `);
    await migrateData(database);
    expect((await database.query(`SELECT * FROM workspace_skill_versions ORDER BY skill_id,version`)).rows).toEqual(before);
    console.log('Demonstrated cleanup-boot: second migration startup made no feedback seed or workflow description writes');
  });

  it('refreshes deployed tool guidance and legacy schedule prompts despite the old completion marker', async () => {
    await backfillFeedbackTriageWorkflow(database);
    await database.query(`DELETE FROM workflow_backfills WHERE name='feedback-triage-prompt-cases-v1'`);
    // Production already holds the earlier markers; the new marker still refreshes the procedure.
    await database.query(`INSERT INTO workflow_backfills(name) VALUES('feedback-triage-v7'),('feedback-triage-adapter-check-v1') ON CONFLICT DO NOTHING`);
    await database.query(`UPDATE agent_schedules SET message=$2 WHERE id=$1`, [UNRELATED_SCHEDULE,
      'Start the feedback-triage workflow with start_workflow, binding triager to yourself, and follow the feedback-triage-steps procedure (load_workspace_skill) at each step.',
    ]);
    const before = await schedules();
    await database.query(
      `UPDATE workspace_skill_versions SET markdown='old procedure',content_hash=$2
       WHERE skill_id=(SELECT id FROM workspace_skills WHERE workspace_id=$1 AND slug='feedback-triage-steps')`,
      [WORKSPACE, 'f'.repeat(64)],
    );
    await migrateData(database);
    const procedure = (await database.query<{ markdown: string }>(
      `SELECT version.markdown FROM workspace_skills skill
       JOIN workspace_skill_versions version ON version.skill_id=skill.id AND version.version=skill.current_version
       WHERE skill.workspace_id=$1 AND skill.slug='feedback-triage-steps'`, [WORKSPACE],
    )).rows[0]!;
    expect(procedure.markdown).toBe(FEEDBACK_TRIAGE_STEPS);
    expect((await skills()).find((skill) => skill.slug === 'feedback-triage-steps')!.current_version).toBe(2);
    expect(procedure.markdown).toContain('occurrence_count');
    expect(procedure.markdown).not.toContain('notice period');
    expect(procedure.markdown).toContain('effective date');
    expect(procedure.markdown).toContain('app_tool(app:beeline:workflow)');
    expect(procedure.markdown).toContain('report(kind:fixed)');
    expect(procedure.markdown).not.toMatch(/start_workflow|notify_feedback_fixed|load_workspace_skill/);
    const after = await schedules();
    expect(after.find((row) => row.id === UNRELATED_SCHEDULE)!.message).toBe(FEEDBACK_TRIAGE_SCHEDULE_PROMPT);
    for (const row of after) {
      const was = before.find((schedule) => schedule.id === row.id);
      if (!was) continue;
      expect(row.cadence).toEqual({ ...DAILY, expression:'0 7 * * *', timeZone: 'America/New_York' });
      expect(row.next_run_at.getTime()).toBeGreaterThan(Date.now());
    }
    const versions = (await database.query<{ version: number; markdown: string }>(
      `SELECT version.version,version.markdown FROM workspace_skills skill
       JOIN workspace_skill_versions version ON version.skill_id=skill.id
       WHERE skill.workspace_id=$1 AND skill.slug='feedback-triage-steps' ORDER BY version.version`, [WORKSPACE],
    )).rows;
    expect(versions.map((version) => version.markdown)).toEqual(['old procedure', FEEDBACK_TRIAGE_STEPS]);
  });

  it('refreshes seeded triage steps for latest-version counts when older markers are already recorded', async () => {
    await backfillFeedbackTriageWorkflow(database);
    await database.query(
      `UPDATE workspace_skill_versions SET markdown='count every occurrence', content_hash=$2
       WHERE skill_id=(SELECT id FROM workspace_skills WHERE workspace_id=$1 AND slug='feedback-triage-steps')`,
      [WORKSPACE, '1'.repeat(64)],
    );
    await database.query(
      `INSERT INTO workflow_backfills(name) VALUES('feedback-triage-prompt-cases-v1') ON CONFLICT DO NOTHING`,
    );
    await database.query(`DELETE FROM workflow_backfills WHERE name='feedback-triage-latest-count-v1'`);
    await migrateData(database);
    const procedure = (await database.query<{ markdown: string }>(
      `SELECT version.markdown FROM workspace_skills skill
       JOIN workspace_skill_versions version ON version.skill_id=skill.id AND version.version=skill.current_version
       WHERE skill.workspace_id=$1 AND skill.slug='feedback-triage-steps'`,
      [WORKSPACE],
    )).rows[0]!;
    expect(procedure.markdown).toBe(FEEDBACK_TRIAGE_STEPS);
    expect(procedure.markdown).toContain('latest-version evidence');
  });

  it('leaves an interrupted backfill unmarked and allows an idempotent retry', async () => {
    await expect(workflowBackfillOnce(database, 'test-retry', async (db) => {
      await db.query(`UPDATE agent_schedules SET message='failed migration' WHERE id=$1`, [TRIAGE_SCHEDULE]);
      throw new Error('interrupted');
    })).rejects.toThrow('interrupted');
    expect((await schedules()).find((row) => row.id === TRIAGE_SCHEDULE)!.message).toBe('failed migration');
    expect((await database.query(`SELECT name FROM workflow_backfills WHERE name='test-retry'`)).rows).toEqual([]);
    await workflowBackfillOnce(database, 'test-retry', backfillFeedbackTriageWorkflow);
    expect((await schedules()).find((row) => row.id === TRIAGE_SCHEDULE)!.message).toBe(FEEDBACK_TRIAGE_SCHEDULE_PROMPT);
    await workflowBackfillOnce(database, 'test-retry', async () => { throw new Error('ran twice'); });
  });

  it('Reproduction cleanup-feedback: leaves unrelated feedback sweep schedules alone', async () => {
    const prompt = 'Run a customer feedback sweep and summarize the survey responses.';
    await database.query(`UPDATE agent_schedules SET message=$2 WHERE id=$1`, [UNRELATED_SCHEDULE, prompt]);
    await backfillFeedbackTriageWorkflow(database);
    expect((await schedules()).find((row) => row.id === UNRELATED_SCHEDULE)!.message).toBe(prompt);
    console.log('Demonstrated cleanup-feedback: migration preserved an unrelated feedback sweep schedule');
  });

  it('tells the triager to judge prompt defects itself, save their cases, and carry them into fix corners', () => {
    // No label: the triager decides, and feedback storage is unchanged.
    expect(FEEDBACK_TRIAGE_STEPS).toContain('Judge each group: is it a prompt defect?');
    expect(FEEDBACK_TRIAGE_STEPS).toContain('No label marks this; decide it yourself.');
    expect(FEEDBACK_TRIAGE_STEPS).toContain('draft its saved case in the format of\n`docs/prompts/cases/README.md`');
    expect(FEEDBACK_TRIAGE_STEPS).toContain('Mark each prompt defect with\n`promptDefect: true`, its section, and its drafted case.');
    expect(FEEDBACK_TRIAGE_STEPS).toContain('Never quote a report, and never name\nthe people, Rooms, Workspaces or emails behind it.');
    expect(FEEDBACK_TRIAGE_STEPS).toContain('For a prompt defect, the brief also carries the drafted case.');
    expect(FEEDBACK_TRIAGE_STEPS).toContain('add that case as `docs/prompts/cases/<id>.json`');
    expect(FEEDBACK_TRIAGE_STEPS).toContain('the worker orders one other agent in the Room to replay every saved case on the\npull request head with its own model');
    expect(FEEDBACK_TRIAGE_STEPS).toContain('The reviewer does not pass the pull request without that table.');
    expect(FEEDBACK_TRIAGE_CONTRACT.handoffs.pull!.requires).toEqual(['problems']);
  });

  it('ends every refusal or did-not-know-how group in a beeline-* skill fix', () => {
    expect(FEEDBACK_TRIAGE_STEPS).toContain('did a Beeline tool refuse the agent, or did the agent not know\nhow to do something here? Each such group ends in a skill fix.');
    expect(FEEDBACK_TRIAGE_STEPS).toContain('Mark each skill fix with\n`skillFix` and the skill name.');
    expect(FEEDBACK_TRIAGE_STEPS).toContain('requires\nthe pull request to change that skill');
  });

  it('preserves a team-authored procedure during either backfill', async () => {
    await backfillFeedbackTriageWorkflow(database);
    await database.query(`UPDATE workspace_skill_versions SET markdown='Team procedure',
      content_hash=$2,extractor_version='save-procedure'
      WHERE skill_id=(SELECT id FROM workspace_skills WHERE workspace_id=$1 AND slug='feedback-triage-steps')`,
      [WORKSPACE, 'e'.repeat(64)]);
    await backfillFeedbackTriageWorkflow(database);
    await backfillFeedbackSignalWalk(database);
    const steps = await loadWorkspaceSkill(database, cornerTurn('team-procedure'), {
      agentId:TRIAGER, roomId:TRIAGE_CORNER, slug:'feedback-triage-steps',
    });
    expect(steps.markdown).toContain('\nTeam procedure\n');
    expect(steps.markdown).not.toContain('## present');
    expect((await skills()).find(skill => skill.slug === 'feedback-triage-steps')!.current_version).toBe(1);
  });

  it('matches the readable copies under docs/workflows and passes the workflow validator', () => {
    const docs = (name: string) =>
      readFileSync(new URL(`../../../docs/workflows/${name}`, import.meta.url), 'utf8');
    expect(JSON.parse(docs('feedback-triage.json'))).toEqual(FEEDBACK_TRIAGE_CONTRACT);
    expect(docs('feedback-triage-steps.md')).toBe(FEEDBACK_TRIAGE_STEPS);
    expect(readWorkflowContract(FEEDBACK_TRIAGE_CONTRACT)).toEqual(FEEDBACK_TRIAGE_CONTRACT);
    expect(JSON.parse(docs('workspace-walk.json'))).toEqual(WORKSPACE_WALK_CONTRACT);
    expect(validateSavedWorkflow(WORKSPACE_WALK_CONTRACT)).toBeNull();
    // The built-in contract meets the same save rules a person's workflow does.
    expect(validateSavedWorkflow(FEEDBACK_TRIAGE_CONTRACT)).toBeNull();
  });

  it('installs the workflow and its steps where a triage schedule runs and points that schedule at it, at 7 AM America/New_York', async () => {
    const before = await schedules();
    expect(await backfillFeedbackTriageWorkflow(database)).toBe(6);
    expect(await skills()).toEqual([
      { slug: 'feedback-triage', kind: 'workflow', current_version: 1 },
      { slug: 'feedback-triage-steps', kind: 'procedure', current_version: 1 },
    ]);
    expect(await skills(OTHER_WORKSPACE)).toHaveLength(2);
    const after = await schedules();
    for (const row of after) {
      const was = before.find((schedule) => schedule.id === row.id);
      if (!was) continue;
      if (row.id === UNRELATED_SCHEDULE) {
        expect(row.cadence).toEqual(was.cadence);
        expect(row.next_run_at).toEqual(was.next_run_at);
      } else {
        expect(row.cadence).toEqual({ ...DAILY, expression:'0 7 * * *', timeZone: 'America/New_York' });
        const hour = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: 'America/New_York' }).format(row.next_run_at);
        expect(hour).toBe('07');
      }
    }
    expect(after.find((row) => row.id === TRIAGE_SCHEDULE)!.message).toBe(FEEDBACK_TRIAGE_SCHEDULE_PROMPT);
    expect(after.find((row) => row.id === SWEEP_SCHEDULE)!.message).toBe(FEEDBACK_TRIAGE_SCHEDULE_PROMPT);
    expect(after.find((row) => row.id === UNRELATED_SCHEDULE)!.message).toBe('Post the standup summary.');
    // A manual rerun is idempotent; migration startup is completion-marker gated.
    expect(await backfillFeedbackTriageWorkflow(database)).toBe(0);
  });

  it('moves an already-New-York seeded schedule from 2 PM to 7 AM', async () => {
    await backfillFeedbackTriageWorkflow(database);
    await database.query(`UPDATE agent_schedules SET cadence=$2::jsonb WHERE id=$1`,
      [TRIAGE_SCHEDULE,JSON.stringify({kind:'cron',expression:'0 14 * * *',timeZone:'America/New_York'})]);
    expect(await backfillFeedbackTriageWorkflow(database)).toBe(1);
    expect((await schedules()).find((row) => row.id===TRIAGE_SCHEDULE)!.cadence)
      .toEqual({kind:'cron',expression:'0 7 * * *',timeZone:'America/New_York'});
  });

  it('lets the scheduled agent find, read and start it right after install, with no setting', async () => {
    await backfillFeedbackTriageWorkflow(database);
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES('schedule-ran',$1,$2,$3)`,
      [TRIAGE_CORNER, CREATOR, FEEDBACK_TRIAGE_SCHEDULE_PROMPT],
    );
    const turn = cornerTurn('schedule-ran');
    const context = await getInstitutionalContext(database, turn);
    expect(context.text).toContain(
      `Workflow feedback-triage (app_tool beeline:workflow start): ${FEEDBACK_TRIAGE_CONTRACT.description}`,
    );
    const steps = await loadWorkspaceSkill(database, turn, {
      agentId: TRIAGER,
      roomId: TRIAGE_CORNER,
      slug: 'feedback-triage-steps',
    });
    expect(steps.markdown).toContain('## Morning-card follow-up (outside this workflow)');
    const started = await startWorkflow(database, turn, {
      name: 'feedback-triage',
      roleBindings: { triager: TRIAGER },
    });
    expect(started.state).toBe('notify');
  });

  it('lets a triager that cannot send Fixed DMs hand off notify as skipped, with a reason, and go on to pull', async () => {
    await backfillFeedbackTriageWorkflow(database);
    await database.query(
      `INSERT INTO messages(id,room_id,author_id,text) VALUES('schedule-ran',$1,$2,$3)`,
      [TRIAGE_CORNER, CREATOR, FEEDBACK_TRIAGE_SCHEDULE_PROMPT],
    );
    const turn = cornerTurn('schedule-ran');
    const { runId } = await startWorkflow(database, turn, {
      name: 'feedback-triage',
      roleBindings: { triager: TRIAGER },
    });
    await expect(
      handoff(database, turn, { runId, outcome: 'skipped', contents: { fixedPullRequests: 'none' } }),
    ).rejects.toThrow('skipReason is required');
    await expect(
      handoff(database, turn, {
        runId,
        outcome: 'skipped',
        contents: {
          fixedPullRequests: 'none',
          skipReason: 'not_system_sender',
          unnotifiedPullRequests: [1968, 1970],
        },
      }),
    ).resolves.toEqual({ runId, state: 'verify', attempt: 1 });
    // The same turn moves the next step only by naming its attempt.
    await expect(
      handoff(database, turn, { runId, outcome: 'nothing_new', contents: { problems: [] } }),
    ).resolves.toEqual({ alreadyAdvanced: true, runId, state: 'verify', seq: 1 });
    await expect(
      handoff(database, turn, { runId, outcome: 'checked', contents: { signalChecks: [] }, attempt: 1 }),
    ).resolves.toEqual({ runId, state: 'pull', attempt: 2 });
  });

  it("refreshes its own outdated seed but never a team's own workflow of the same name", async () => {
    await backfillFeedbackTriageWorkflow(database);
    await database.query(
      `UPDATE workspace_skill_versions SET content_hash=$2
       WHERE skill_id=(SELECT id FROM workspace_skills WHERE workspace_id=$1 AND slug='feedback-triage')`,
      [WORKSPACE, 'f'.repeat(64)],
    );
    await database.query(
      `UPDATE workspace_skill_versions SET content_hash=$2,extractor_version='save-workflow'
       WHERE skill_id=(SELECT id FROM workspace_skills WHERE workspace_id=$1 AND slug='feedback-triage')`,
      [OTHER_WORKSPACE, 'f'.repeat(64)],
    );
    expect(await backfillFeedbackTriageWorkflow(database)).toBe(1);
    expect((await skills()).find((skill) => skill.slug === 'feedback-triage')!.current_version).toBe(2);
    expect(
      (await skills(OTHER_WORKSPACE)).find((skill) => skill.slug === 'feedback-triage')!.current_version,
    ).toBe(1);
  });
});
