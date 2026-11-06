import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateSavedWorkflow, type WorkflowContract } from '@beeline/api-contract/daemon';
import { createAgentCommand } from './agent-command.js';
import { migrateData } from './database.js';
import { PgliteDatabase, migratedDatabase } from './test-support.js';
import { createWorkspace } from './workspace-creation.js';
import { getWorkflowRun, handoff, startWorkflow } from './workflow-runs.js';
import { backfillWelcomeVideoWorkflow, seedWelcomeVideoWorkflow, WELCOME_VIDEO_SLUG } from './welcome-video-workflow.js';

const OWNER = 'a'.repeat(64);
const MAKER = 'b'.repeat(64);
const CHECKER = 'c'.repeat(64);
let db: PgliteDatabase;
let workspace: { id: string; roomId: string };

beforeEach(async () => {
  db = await migratedDatabase();
  await db.query(`INSERT INTO identities(id,kind,name) VALUES
    ($1,'human','Owner'),($2,'agent','Beebee'),($3,'agent','Luna')`, [OWNER, MAKER, CHECKER]);
  workspace = await db.transaction(tx => createWorkspace(tx, { name: 'Welcome' }, OWNER));
  await db.query(`INSERT INTO agents(agent_id,owner_id,selected_model) VALUES($1,$3,'default'),($2,$3,'default')`, [MAKER, CHECKER, OWNER]);
  for (const roomId of [null, workspace.roomId]) {
    await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role)
      VALUES($1,$2,$3,'member'),($1,$2,$4,'member')`, [workspace.id, roomId, MAKER, CHECKER]);
  }
});

afterEach(async () => { await db.close(); });

async function saved() {
  return (await db.query<{ id: string; current_version: number; revision: string; markdown: string; content_hash: string }>(
    `SELECT skill.id,skill.current_version,skill.revision,version.markdown,version.content_hash
     FROM workspace_skills skill JOIN workspace_skill_versions version
       ON version.skill_id=skill.id AND version.version=skill.current_version
     WHERE skill.workspace_id=$1 AND skill.slug=$2`, [workspace.id, WELCOME_VIDEO_SLUG])).rows[0]!;
}

// A live pre-upgrade run still needs its script step and old required fields.
const legacy: WorkflowContract = {
  version: 1, name: WELCOME_VIDEO_SLUG, description: 'Make and approve your free vertical welcome video',
  summary: 'Make a long welcome video.', roles: ['writer', 'maker', 'checker', 'owner'], start: 'gather',
  handoffs: {
    gather: { does: 'Collect facts.', role: 'writer', requires: ['facts'],
      on: { ready: 'script', timeout: 'failed' }, timeoutSeconds: 600 },
    script: { does: 'Write the 75-second vertical script.', role: 'writer', requires: ['script', 'shots'],
      on: { ready: 'done', timeout: 'failed' }, timeoutSeconds: 900 },
    done: { does: 'Finished.', kind: 'terminal', status: 'done' },
    failed: { does: 'Stopped.', kind: 'terminal', status: 'failed' },
  },
};

async function installLegacy() {
  const current = await saved();
  const markdown = JSON.stringify(legacy);
  await db.query(`UPDATE workspace_skill_versions SET markdown=$2,content_hash=$3,extractor_version='welcome-video-v1'
    WHERE skill_id=$1 AND version=1`, [current.id, markdown, createHash('sha256').update(markdown).digest('hex')]);
  return markdown;
}

describe('welcome reel workflow', () => {
  it('seeds a valid short video-model workflow without the long-film stages', async () => {
    const current = await saved();
    const contract = JSON.parse(current.markdown) as WorkflowContract;
    expect(validateSavedWorkflow(contract)).toBeNull();
    expect(current.current_version).toBe(1);
    expect(contract.handoffs).toHaveProperty('make_reel');
    expect(contract.handoffs).toHaveProperty('check_reel');
    for (const retired of ['script', 'signup_stills', 'check_keys', 'stills', 'motion', 'edit', 'check_film']) {
      expect(contract.handoffs).not.toHaveProperty(retired);
      expect(JSON.stringify(contract.handoffs.nudge)).not.toContain(`"${retired}"`);
    }
    expect(Object.keys(contract.handoffs)).toHaveLength(9);
    expect(current.markdown).not.toMatch(/75.second|75s|banter|12 stills|two voices|natural TTS|narration WAV|silencedetect/i);
    for (const step of ['gather', 'make_reel', 'check_reel'])
      expect(contract.handoffs[step]!.hint).toContain('Target 6-9 seconds; hard maximum 15 seconds.');
    expect(contract.handoffs.make_reel!.hint).toContain('actual video-model output');
    expect(contract.handoffs.make_reel).toMatchObject({ requires: expect.arrayContaining(['model_output_object_id', 'generation_evidence']) });
    expect(contract.handoffs.check_reel!.hint).toContain('Reject any clip over 15 seconds');
    expect(contract.handoffs.check_reel!.hint).toContain('You must not be its maker');
    expect(contract.handoffs.check_reel!.hint).toContain('ffprobe');
  });

  it('retains signup, account, spend, connection and preview consent rules', async () => {
    const contract = JSON.parse((await saved()).markdown) as WorkflowContract;
    for (const state of Object.values(contract.handoffs)) {
      if (state.kind === 'terminal') continue;
      for (const rule of ['Spend $0; no cards/deposits or purchased credits', "Use only the current person's connected accounts",
        'No ElevenLabs or Cloudflare accounts/keys', 'Use Squire for signups and approval cards',
        'verify the selected account belongs to that person']) expect(state.hint).toContain(rule);
    }
    expect(contract.handoffs.gather!.hint).toContain('First use connect for YouTube');
    expect(contract.handoffs.signup_video!.hint).toContain('Use Squire to sign up yourself');
    expect(contract.handoffs.signup_video!.hint).toContain('do not assume an API is free');
    for (const rule of ['onboarding video_preview', 'do not upload or auto-answer',
      'a finished workflow is never upload approval', 'Cancel means no upload'])
      expect(contract.handoffs.show_preview!.hint).toContain(rule);
    expect(contract.handoffs.stuck).toMatchObject({ kind: 'gate', on: { retry: 'nudge', abandon: 'failed' }, default: 'abandon' });
  });

  it('upgrades existing seeds through the release migration after the old backfill ran and starter agents left', async () => {
    const old = await installLegacy();
    expect((await db.query('SELECT 1 FROM free_agents')).rowCount).toBe(0);
    await db.query(`INSERT INTO workflow_backfills(name) VALUES('welcome-video-v1') ON CONFLICT DO NOTHING`);
    await db.query(`DELETE FROM workflow_backfills WHERE name='welcome-video-v2'`);
    await migrateData(db);
    const current = await saved();
    expect(current.current_version).toBe(2);
    expect(Number(current.revision)).toBe(2);
    expect(JSON.parse(current.markdown).handoffs.make_reel).toBeTruthy();
    expect((await db.query(`SELECT markdown FROM workspace_skill_versions WHERE skill_id=$1 AND version=1`, [current.id])).rows[0]!.markdown).toBe(old);
    expect((await db.query(`SELECT name FROM workflow_backfills WHERE name IN ('welcome-video-v1','welcome-video-v2') ORDER BY name`)).rows)
      .toEqual([{ name: 'welcome-video-v1' }, { name: 'welcome-video-v2' }]);
    await backfillWelcomeVideoWorkflow(db);
    await db.transaction(tx => seedWelcomeVideoWorkflow(tx, workspace.id, workspace.roomId));
    expect(await saved()).toEqual(current);
    expect((await db.query(`SELECT 1 FROM workspace_skill_versions WHERE skill_id=$1`, [current.id])).rowCount).toBe(2);
  });

  it.each(['archived', 'stale', 'customized', 'procedure'])('preserves a %s workflow instead of replacing it', async mode => {
    const old = await installLegacy();
    const current = await saved();
    if (mode === 'archived' || mode === 'stale')
      await db.query(`UPDATE workspace_skills SET state=$2 WHERE id=$1`, [current.id, mode]);
    if (mode === 'procedure') await db.query(`UPDATE workspace_skills SET kind='procedure' WHERE id=$1`, [current.id]);
    if (mode === 'customized') await db.query(`UPDATE workspace_skill_versions SET extractor_version='workflow-save-v1' WHERE skill_id=$1`, [current.id]);
    await backfillWelcomeVideoWorkflow(db);
    await db.transaction(tx => seedWelcomeVideoWorkflow(tx, workspace.id, workspace.roomId));
    expect((await saved()).current_version).toBe(1);
    expect((await saved()).markdown).toBe(old);
  });

  it('keeps an in-flight run on its old contract while new runs use the reel revision', async () => {
    await installLegacy();
    const sourceId = 'welcome-request';
    await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Make my welcome video')`, [sourceId, workspace.roomId, OWNER]);
    const command = await createAgentCommand(db, { roomId: workspace.roomId, agentId: MAKER, sourceMessageId: sourceId, reason: 'test' });
    if (!command) throw new Error('command not created');
    const roleBindings = { writer: MAKER, maker: MAKER, checker: CHECKER, owner: MAKER };
    const oldRun = await startWorkflow(db, command, { name: WELCOME_VIDEO_SLUG, roleBindings });
    await backfillWelcomeVideoWorkflow(db);
    const pinned = await getWorkflowRun(db, workspace.roomId, oldRun.runId);
    expect(pinned.workflowVersion).toBe(1);
    expect(pinned.contract.handoffs.script!.does).toContain('75-second');
    await handoff(db, command, { runId: oldRun.runId, attempt: pinned.attempt, outcome: 'ready', contents: { facts: 'Public project' } });
    expect((await getWorkflowRun(db, workspace.roomId, oldRun.runId)).state).toBe('script');

    const room = '20000000-0000-4000-8000-000000000002';
    await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'New reel')`, [room, workspace.id]);
    for (const agent of [MAKER, CHECKER])
      await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [workspace.id, room, agent]);
    const newRun = await startWorkflow(db, { room_id: room, agent_id: MAKER }, { name: WELCOME_VIDEO_SLUG, roleBindings });
    const fresh = await getWorkflowRun(db, room, newRun.runId);
    expect(fresh.workflowVersion).toBe(2);
    expect(fresh.contract.handoffs).toHaveProperty('make_reel');
    expect(fresh.contract.handoffs).not.toHaveProperty('script');
  });
});
