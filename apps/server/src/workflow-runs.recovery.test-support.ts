import { HelperDaemonService } from './test-fixtures/helper-daemon.js';

import { normalizeLegacyWorkflowRuns, saveUnsavedWorkflowRunStatus } from './migrations/workflow-cleanup.js';

import { workflowRunIsLiveSql, workflowRunStatusUnsavedSql } from './workflow-run-saved-status.js';

import { listRoomWorkflowRuns, readWorkflowRun } from './workflow-run-views.js';

import { activeWorkflowRunIds } from './workflow-admin.js';

import { DaemonService } from './daemon-service.js';

import { LiveHub } from './live.js';

import { describedWorkflow } from './test-support.js';

import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { migrate, migrateData, type SqlDatabase } from './database.js';

import { claimAgentCommand, createAgentCommand, readAgentCommands, type CommandRow } from './agent-command.js';

import { postRoomChoice } from './room-choice.js';

import { AgentScheduleLoop } from './agent-schedules.js';

import { PhoneService } from './phone-service.js';

import { FEEDBACK_TRIAGE_CONTRACT } from './feedback-triage-workflow.js';

import { activeRunIdsForSchedule, assignWorkflowRole, backfillWorkflowRunTimers, backfillWorkflowSkillDescriptions, describedLegacyWorkflowContract, handoff, getWorkflowRun, cancelWorkflowRun, liveWorkflowRun, saveWorkflow, settleWorkflowGate, startWorkflow, WORKFLOW_LEGACY_STEP_TIMEOUT_SECONDS } from './workflow-runs.js';

import { APPROVER, CONTRACT, GATED, IMPLEMENTER, LIST_CONTRACT, OUTSIDER, OWNER, REVIEWER, ROOM, RecordingDatabase, WORKER_A, WORKER_B, WORKSPACE, addAgent, adminCommand, answerGate, commandFor, database, driveToApprovalGate, fireTimer, listRunCard, ownerNotices, pendingCommandsFor, reachGate, reportPresence, rootMessage, runCards, startedGatedRun, startedListRun, startedRun, withoutTimeouts } from './test-fixtures/workflow-runs.js';


vi.mock('node:crypto', async (importOriginal) => {
  const crypto = await importOriginal<typeof import('node:crypto')>();
  return { ...crypto, randomBytes: vi.fn(crypto.randomBytes) };
});
export function fixtureScope1() {

  /** Simulates a workflow skill version saved before PR #2083 added `summary`/`does`. */
  async function seedLegacySkillVersion(slug: string, markdown: string, extractorVersion = 'legacy-test'): Promise<string> {
    const skillId = randomUUID();
    await database.query(
      `INSERT INTO workspace_skills
         (id,workspace_id,slug,description,state,current_version,revision,source_room_id,
          repository,target_commit,path,kind)
       VALUES($1,$2,$3,'legacy workflow','active',1,1,$4,'','',NULL,'workflow')`,
      [skillId, WORKSPACE, slug, ROOM],
    );
    await database.query(
      `INSERT INTO workspace_skill_versions
         (skill_id,version,markdown,content_hash,source_job_id,source_message_ids,
          repository,target_commit,path,extractor_version,model)
       VALUES($1,1,$2,$3,NULL,$4,'','',NULL,$5,'n/a')`,
      [skillId, markdown, createHash('sha256').update(markdown).digest('hex'), ['legacy-seed'], extractorVersion],
    );
    return skillId;
  }


  async function markdownFor(skillId: string): Promise<string> {
    return (
      await database.query<{ markdown: string }>(
        `SELECT markdown FROM workspace_skill_versions WHERE skill_id=$1 AND version=1`,
        [skillId],
      )
    ).rows[0]!.markdown;
  }
return {
seedLegacySkillVersion,
markdownFor,
};
}
export function fixtureScope7() {

  beforeEach(async () => {
    // Simulate the first deployment over legacy fixtures, before its one-time marker.
    await database.query(`DELETE FROM workflow_backfills WHERE name='workflow-storage-v1'`);
  });

  async function timersFor(runId: string) {
    return (await database.query<{ id: string; next_run_at: Date; updated_at: Date; workflow_run: { timer: string; attempt?: number } }>(
      `SELECT id,next_run_at,updated_at,workflow_run FROM agent_schedules
       WHERE workflow_run->>'runId'=$1 ORDER BY workflow_run->>'timer'`, [runId],
    )).rows;
  }


  async function removeStepTimeout(slug: string, state: string) {
    await database.query(
      `UPDATE workspace_skill_versions version SET markdown=(markdown::jsonb #- $2::text[])::text
       FROM workspace_skills skill WHERE skill.id=version.skill_id AND skill.slug=$1`,
      [slug, ['handoffs', state, 'timeoutSeconds']],
    );
  }
return {
timersFor,
removeStepTimeout,
};
}
export function fixtureScope10() {

  beforeEach(async () => {
    // The app's run views also require the viewer's Workspace membership.
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner')`, [WORKSPACE, OWNER]);
  });


  async function savedStatus(runId: string): Promise<string | null> {
    return (await database.query<{ run_status: string | null }>(
      `SELECT card->>'runStatus' run_status FROM messages WHERE id=$1`, [runId],
    )).rows[0]!.run_status;
  }


  /** The start card, the agent read, the app's run page and list, and every SQL live check agree. */
  async function expectStatus(runId: string, expected: 'live' | 'done' | 'failed' | 'abandoned') {
    const live = expected === 'live';
    expect(await savedStatus(runId)).toBe(expected);
    expect((await getWorkflowRun(database, ROOM, runId)).status).toBe(expected);
    expect((await readWorkflowRun(database, { roomId: ROOM, runId }, OWNER))?.run.status).toBe(expected);
    const listed = (await listRoomWorkflowRuns(database, ROOM, OWNER, 'gated')).workflows;
    expect(listed.find((run) => run.runId === runId)?.status).toBe(expected);
    expect((await liveWorkflowRun(database, ROOM, 'gated'))?.runId === runId).toBe(live);
    expect((await activeWorkflowRunIds(database, ROOM, 'gated', OWNER)).includes(runId)).toBe(live);
    await database.query(
      `UPDATE messages SET card=card || jsonb_build_object('trigger',jsonb_build_object('scheduleId','status-schedule','period','p')) WHERE id=$1`,
      [runId],
    );
    expect((await activeRunIdsForSchedule(database, ROOM, 'status-schedule')).includes(runId)).toBe(live);
  }


  async function everyEnding(): Promise<Record<'done' | 'failed' | 'deadline' | 'cancelled', string>> {
    const done = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    await expectStatus(done, 'live');
    await reachGate(done);
    await expectStatus(done, 'live');
    await answerGate(done, 'publish');
    await expectStatus(done, 'done');

    const failed = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    await reachGate(failed);
    await answerGate(failed, 'stop');
    await expectStatus(failed, 'failed');

    const deadline = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    expect(await fireTimer(deadline, 'deadline')).toBe(1);
    await expectStatus(deadline, 'failed');

    const cancelled = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    await cancelWorkflowRun(database, { room_id: ROOM, agent_id: OWNER } as CommandRow, { runId: cancelled, reason: 'stop' });
    await expectStatus(cancelled, 'abandoned');
    return { done, failed, deadline, cancelled };
  }
return {
savedStatus,
expectStatus,
everyEnding,
};
}
export function fixtureScope11() {

  async function signupRun() {
    const command = await adminCommand();
    const contract = describedWorkflow({
      version: 1, name: 'signup-recovery', description: 'Recover signup without a provider key',
      roles: ['maker', 'owner'], start: 'signup_stills',
      handoffs: {
        signup_stills: { role: 'maker', requires: ['vault_reference'], timeoutSeconds: 60,
          on: { ready: 'done', timeout: 'recover' } },
        recover: { kind: 'gate', role: 'owner', requires: ['decision'],
          on: { retry: 'signup_stills', abandon: 'failed' }, timeoutSeconds: 600, default: 'abandon' },
        done: { kind: 'terminal', status: 'done' },
        failed: { kind: 'terminal', status: 'failed' },
      },
    });
    await saveWorkflow(database, command, { contract });
    return startWorkflow(database, command, {
      name: 'signup-recovery', roleBindings: { maker: WORKER_A, owner: APPROVER },
    });
  }
return {
signupRun,
};
}
export { HelperDaemonService } from './test-fixtures/helper-daemon.js';
export { normalizeLegacyWorkflowRuns, saveUnsavedWorkflowRunStatus } from './migrations/workflow-cleanup.js';
export { workflowRunIsLiveSql, workflowRunStatusUnsavedSql } from './workflow-run-saved-status.js';
export { listRoomWorkflowRuns, readWorkflowRun } from './workflow-run-views.js';
export { activeWorkflowRunIds } from './workflow-admin.js';
export { DaemonService } from './daemon-service.js';
export { LiveHub } from './live.js';
export { describedWorkflow } from './test-support.js';
export { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
export { createHash, randomBytes, randomUUID } from 'node:crypto';
export { beforeEach, describe, expect, it, vi } from 'vitest';
export { migrate, migrateData } from './database.js';
export { claimAgentCommand, createAgentCommand, readAgentCommands } from './agent-command.js';
export { postRoomChoice } from './room-choice.js';
export { AgentScheduleLoop } from './agent-schedules.js';
export { PhoneService } from './phone-service.js';
export { FEEDBACK_TRIAGE_CONTRACT } from './feedback-triage-workflow.js';
export { activeRunIdsForSchedule, assignWorkflowRole, backfillWorkflowRunTimers, backfillWorkflowSkillDescriptions, describedLegacyWorkflowContract, handoff, getWorkflowRun, cancelWorkflowRun, liveWorkflowRun, saveWorkflow, settleWorkflowGate, startWorkflow, WORKFLOW_LEGACY_STEP_TIMEOUT_SECONDS } from './workflow-runs.js';
export { APPROVER, CONTRACT, GATED, IMPLEMENTER, LIST_CONTRACT, OUTSIDER, OWNER, REVIEWER, ROOM, RecordingDatabase, WORKER_A, WORKER_B, WORKSPACE, addAgent, adminCommand, answerGate, commandFor, database, driveToApprovalGate, fireTimer, listRunCard, ownerNotices, pendingCommandsFor, reachGate, reportPresence, rootMessage, runCards, startedGatedRun, startedListRun, startedRun, withoutTimeouts } from './test-fixtures/workflow-runs.js';
export type { SqlDatabase } from './database.js';
export type { CommandRow } from './agent-command.js';
