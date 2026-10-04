import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readWorkflowContract } from '@beeline/api-contract/daemon';
import type { CommandRow } from './agent-command.js';
import { migrate } from './database.js';
import {
  FEEDBACK_TRIAGE_CONTRACT,
  FEEDBACK_TRIAGE_SCHEDULE_PROMPT,
  FEEDBACK_TRIAGE_STEPS,
  backfillFeedbackTriageWorkflow,
} from './feedback-triage-workflow.js';
import { getInstitutionalContext } from './institutional-memory-shadow.js';
import { loadWorkspaceSkill } from './institutional-skills.js';
import { PgliteDatabase } from './test-support.js';
import { handoff, startWorkflow } from './workflow-runs.js';

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
  await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [TRIAGER, CREATOR]);
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
  for (const roomId of [ROOM, TRIAGE_CORNER])
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
  it('matches the readable copies under docs/workflows and passes the workflow validator', () => {
    const docs = (name: string) =>
      readFileSync(new URL(`../../../docs/workflows/${name}`, import.meta.url), 'utf8');
    expect(JSON.parse(docs('feedback-triage.json'))).toEqual(FEEDBACK_TRIAGE_CONTRACT);
    expect(docs('feedback-triage-steps.md')).toBe(FEEDBACK_TRIAGE_STEPS);
    expect(readWorkflowContract(FEEDBACK_TRIAGE_CONTRACT)).toEqual(FEEDBACK_TRIAGE_CONTRACT);
  });

  it('installs the workflow and its steps where a triage schedule runs and points that schedule at it, cadence unchanged', async () => {
    const before = await schedules();
    expect(await backfillFeedbackTriageWorkflow(database)).toBe(6);
    expect(await skills()).toEqual([
      { slug: 'feedback-triage', kind: 'workflow', current_version: 1 },
      { slug: 'feedback-triage-steps', kind: 'procedure', current_version: 1 },
    ]);
    expect(await skills(OTHER_WORKSPACE)).toHaveLength(2);
    const after = await schedules();
    for (const row of after) {
      const was = before.find((schedule) => schedule.id === row.id)!;
      expect(row.cadence, row.id).toEqual(was.cadence);
      expect(row.next_run_at, row.id).toEqual(was.next_run_at);
    }
    expect(after.find((row) => row.id === TRIAGE_SCHEDULE)!.message).toBe(FEEDBACK_TRIAGE_SCHEDULE_PROMPT);
    expect(after.find((row) => row.id === SWEEP_SCHEDULE)!.message).toBe(FEEDBACK_TRIAGE_SCHEDULE_PROMPT);
    expect(after.find((row) => row.id === UNRELATED_SCHEDULE)!.message).toBe('Post the standup summary.');
    // Every release reruns it; nothing changes twice.
    expect(await backfillFeedbackTriageWorkflow(database)).toBe(0);
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
      `Workflow feedback-triage (start_workflow): ${FEEDBACK_TRIAGE_CONTRACT.description}`,
    );
    const steps = await loadWorkspaceSkill(database, turn, {
      agentId: TRIAGER,
      roomId: TRIAGE_CORNER,
      slug: 'feedback-triage-steps',
    });
    expect(steps.markdown).toContain('## dispatch');
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
    ).resolves.toEqual({ runId, state: 'pull' });
    await expect(
      handoff(database, turn, { runId, outcome: 'nothing_new', contents: { problems: [] } }),
    ).resolves.toEqual({ runId, state: 'done', status: 'done' });
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
