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
import { activeRunIdsForSchedule, assignWorkflowRole, backfillWorkflowSkillDescriptions, describedLegacyWorkflowContract, handoff, getWorkflowRun, cancelWorkflowRun, liveWorkflowRun, saveWorkflow, settleWorkflowGate, startWorkflow } from './workflow-runs.js';
import { APPROVER, CONTRACT, GATED, IMPLEMENTER, LIST_CONTRACT, OUTSIDER, OWNER, REVIEWER, ROOM, RecordingDatabase, WORKER_A, WORKER_B, WORKSPACE, addAgent, adminCommand, answerGate, commandFor, database, driveToApprovalGate, listRunCard, ownerNotices, pendingCommandsFor, reachGate, reportPresence, rootMessage, runCards, startedGatedRun, startedListRun, startedRun, withoutTimeouts } from './test-fixtures/workflow-runs.js';

vi.mock('node:crypto', async (importOriginal) => {
  const crypto = await importOriginal<typeof import('node:crypto')>();
  return { ...crypto, randomBytes: vi.fn(crypto.randomBytes) };
});

describe('backfillWorkflowSkillDescriptions', () => {
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

  it('derives each custom step from its own instruction or fields and is idempotent', async () => {
    const markdown = JSON.stringify(CONTRACT);
    const skillId = await seedLegacySkillVersion('legacy-corner', markdown);

    await expect(backfillWorkflowSkillDescriptions(database)).resolves.toBe(1);

    const described = JSON.parse(await markdownFor(skillId));
    expect(described.summary).toBe(CONTRACT.description);
    expect(described.handoffs.implement.does).toBe('Produce summary, PR URL for implement.');
    expect(described.handoffs.human_approve.does).toBe('Ask a person for decision.');
    // Terminal states get a does too: validateSavedWorkflow requires one on
    // every state, with no exception, so the backfill cannot skip them.
    expect(described.handoffs.land.does).toBe('The workflow finished.');
    expect(described.handoffs.failed.does).toBe('The workflow stopped because a step failed.');
    expect(JSON.stringify(described)).not.toContain('describe what this step does');
    // Every edge, role binding and loop rule survived untouched.
    expect(described.handoffs.checks.loop).toEqual(CONTRACT.handoffs.checks.loop);
    expect(described.start).toBe(CONTRACT.start);
    expect(described.roles).toEqual(CONTRACT.roles);

    // Exactly what a caller describing this same legacy contract before a
    // normal save would get from the pure half of this migration.
    expect(described).toEqual(describedLegacyWorkflowContract(CONTRACT as never));

    // Idempotent: a second run has nothing left to fill.
    await expect(backfillWorkflowSkillDescriptions(database)).resolves.toBe(0);
    expect(await markdownFor(skillId)).toBe(JSON.stringify(described));
  });

  it('writes a usable summary when the description is empty', async () => {
    const blank = { ...CONTRACT, description: '   ' };
    const skillId = await seedLegacySkillVersion('legacy-blank', JSON.stringify(blank));
    await expect(backfillWorkflowSkillDescriptions(database)).resolves.toBe(1);
    expect(JSON.parse(await markdownFor(skillId)).summary).toBe('Run the corner workflow.');
  });

  it('repairs every saved seeded version with authored copy and serves the repaired current version', async () => {
    const stale = JSON.parse(JSON.stringify(FEEDBACK_TRIAGE_CONTRACT));
    stale.summary = 'Summary not written yet';
    for (const [name, step] of Object.entries(stale.handoffs))
      step.does = `Step ${name}: describe what this step does`;
    const skillId = await seedLegacySkillVersion('feedback-triage', JSON.stringify(stale), 'feedback-triage-v1');
    await database.query(
      `INSERT INTO workspace_skill_versions
         (skill_id,version,markdown,content_hash,source_job_id,source_message_ids,
          repository,target_commit,path,extractor_version,model)
       VALUES($1,2,$2,$3,NULL,$4,'','',NULL,'feedback-triage-v1','n/a')`,
      [skillId, JSON.stringify(stale), createHash('sha256').update(JSON.stringify(stale)).digest('hex'), ['legacy-seed']],
    );
    await database.query(`UPDATE workspace_skills SET current_version=2 WHERE id=$1`, [skillId]);

    await expect(backfillWorkflowSkillDescriptions(database)).resolves.toBe(2);
    const versions = (await database.query<{ markdown: string; content_hash: string }>(
      `SELECT markdown,content_hash FROM workspace_skill_versions WHERE skill_id=$1 ORDER BY version`, [skillId],
    )).rows;
    for (const version of versions) {
      const contract = JSON.parse(version.markdown);
      expect(contract.summary).toBe(FEEDBACK_TRIAGE_CONTRACT.summary);
      for (const [name, step] of Object.entries(FEEDBACK_TRIAGE_CONTRACT.handoffs))
        expect(contract.handoffs[name].does).toBe(step.does);
      expect(version.markdown).not.toContain('describe what this step does');
      expect(version.content_hash).toBe(createHash('sha256').update(version.markdown).digest('hex'));
    }
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner')`,
      [WORKSPACE, OWNER],
    );
    const command = await commandFor(WORKER_A);
    const { runId } = await startWorkflow(database, command, {
      name: 'feedback-triage', roleBindings: { triager: WORKER_A },
    });
    const served = await readWorkflowRun(database, { roomId: ROOM, runId }, OWNER);
    expect(served?.contract.handoffs.pull?.does).toBe(FEEDBACK_TRIAGE_CONTRACT.handoffs.pull.does);
    expect(JSON.stringify(served?.contract)).not.toContain('describe what this step does');
    const definition = await new PhoneService(database, 'http://localhost').execute(
      'readWorkflowDefinition', { roomId: ROOM, name: 'feedback-triage' }, OWNER,
    );
    expect(definition.contract.handoffs.pull.does).toBe(FEEDBACK_TRIAGE_CONTRACT.handoffs.pull.does);
    expect(JSON.stringify(definition.contract)).not.toContain('describe what this step does');
    await expect(backfillWorkflowSkillDescriptions(database)).resolves.toBe(0);
  });

  it('uses a custom step hint instead of its old placeholder', async () => {
    const legacy = JSON.parse(JSON.stringify(CONTRACT));
    legacy.handoffs.implement.hint = '  Draft the change and open a pull request.  ';
    legacy.handoffs.implement.does = 'Step implement (implementer): describe what this step does';
    const skillId = await seedLegacySkillVersion('custom-hint', JSON.stringify(legacy));
    await backfillWorkflowSkillDescriptions(database);
    expect(JSON.parse(await markdownFor(skillId)).handoffs.implement.does)
      .toBe('Draft the change and open a pull request.');
  });

  it('leaves an already-described contract untouched, including its content hash', async () => {
    const markdown = JSON.stringify(describedWorkflow(CONTRACT), null, 2);
    const skillId = await seedLegacySkillVersion('already-described', markdown);
    const before = (
      await database.query<{ content_hash: string }>(
        `SELECT content_hash FROM workspace_skill_versions WHERE skill_id=$1 AND version=1`,
        [skillId],
      )
    ).rows[0]!.content_hash;

    await expect(backfillWorkflowSkillDescriptions(database)).resolves.toBe(0);

    const after = await database.query<{ markdown: string; content_hash: string }>(
      `SELECT markdown,content_hash FROM workspace_skill_versions WHERE skill_id=$1 AND version=1`,
      [skillId],
    );
    expect(after.rows[0]).toEqual({ markdown, content_hash: before });
  });

  it('is unaffected by a non-workflow skill and a deleted workflow version', async () => {
    await database.query(
      `INSERT INTO workspace_skills
         (id,workspace_id,slug,description,state,current_version,revision,source_room_id,
          repository,target_commit,path,kind)
       VALUES($1,$2,'a-procedure','A procedure','active',1,1,$3,'','',NULL,'procedure')`,
      [randomUUID(), WORKSPACE, ROOM],
    );
    const deletedSkillId = randomUUID();
    await database.query(
      `INSERT INTO workspace_skills
         (id,workspace_id,slug,description,state,current_version,revision,source_room_id,
          repository,target_commit,path,kind)
       VALUES($1,$2,'deleted-workflow','Deleted','active',1,1,$3,'','',NULL,'workflow')`,
      [deletedSkillId, WORKSPACE, ROOM],
    );
    await database.query(
      `INSERT INTO workspace_skill_versions
         (skill_id,version,markdown,content_hash,source_job_id,source_message_ids,
          repository,target_commit,path,extractor_version,model,source_deleted_at)
       VALUES($1,1,'',$2,NULL,$3,'','',NULL,'legacy-test','n/a',now())`,
      [deletedSkillId, createHash('sha256').update('').digest('hex'), ['legacy-seed']],
    );
    await expect(backfillWorkflowSkillDescriptions(database)).resolves.toBe(0);
  });
});

describe('attempts: stale and repeated handoffs never advance a run twice', () => {
  it('uses its own workflow wake attempt while an unrelated command stays pending', async () => {
    await database.query('INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)', [IMPLEMENTER, OWNER]);
    await createAgentCommand(database, { roomId: ROOM, agentId: IMPLEMENTER, sourceMessageId: null,
      reason: 'corner_brief', privatePayload: { text: 'Unrelated lifecycle head', authorId: REVIEWER, fromRoomId: ROOM, kind: 'lifecycle' } });
    const { runId } = await startedRun();

    const pending = (await readAgentCommands(database, ROOM, IMPLEMENTER)).commands;
    const workflowCommand = pending.find(command => command.source.body !== 'Unrelated lifecycle head')!;
    const unrelated = pending.find(command => command.source.body === 'Unrelated lifecycle head')!;
    expect(unrelated).toBeDefined();
    const claimed = await database.transaction(tx => claimAgentCommand(tx, ROOM, IMPLEMENTER, workflowCommand.id, 'workflow-attempt'));
    await handoff(database, claimed, {
      runId, outcome: 'pushed', contents: { summary: 'Advanced the first step', prUrl: 'https://test/pr/1' }, attempt: 0,
    });
    expect(await handoff(database, claimed, { runId, outcome: 'passing', contents: { headSha: 'old-work' } }))
      .toEqual({ alreadyAdvanced: true, runId, state: 'checks', seq: 1 });
    expect((await getWorkflowRun(database, ROOM, runId)).state).toBe('checks');
    expect((await database.query('SELECT state FROM agent_commands WHERE id=$1', [unrelated.id])).rows).toEqual([{state:'pending'}]);
  });
  it('returns the same result for a repeated handoff with its attempt, writing one card', async () => {
    const { runId } = await startedRun();
    const call = { runId, outcome: 'pushed', contents: { summary: 'x', prUrl: 'y' }, attempt: 0 };
    const first = await handoff(database, await commandFor(IMPLEMENTER), call);
    const again = await handoff(database, await commandFor(IMPLEMENTER), call);
    expect(first).toEqual({ runId, state: 'checks', attempt: 1 });
    expect(again).toEqual(first);
    expect(await runCards(runId)).toHaveLength(2);
  });

  it('reads a missing attempt from the wake the command answers, so a repeat changes nothing', async () => {
    const { runId } = await startedRun();
    const woken = await commandFor(IMPLEMENTER, runId);
    const call = { runId, outcome: 'pushed', contents: { summary: 'x', prUrl: 'y' } };
    expect(await handoff(database, woken, call)).toEqual({ runId, state: 'checks', attempt: 1 });
    expect(await handoff(database, woken, call)).toEqual({ runId, state: 'checks', attempt: 1 });
    expect(await runCards(runId)).toHaveLength(2);
  });

  it('tells a stale attempt the step already advanced, with the current state, and changes nothing', async () => {
    const { runId } = await startedRun();
    await handoff(database, await commandFor(IMPLEMENTER), {
      runId, outcome: 'pushed', contents: { summary: 'x', prUrl: 'y' }, attempt: 0,
    });
    const stale = await handoff(database, await commandFor(IMPLEMENTER), {
      runId, outcome: 'stuck', contents: { summary: 'x', prUrl: 'y' }, attempt: 0,
    });
    expect(stale).toEqual({ alreadyAdvanced: true, runId, state: 'checks', seq: 1 });
    expect(await runCards(runId)).toHaveLength(2);
  });

  it('does not let one wake move the same agent through successive steps by accident', async () => {
    const { runId } = await startedRun();
    // IMPLEMENTER holds both implement and checks. Its wake is attempt 0.
    const woken = await commandFor(IMPLEMENTER, runId);
    await handoff(database, woken, { runId, outcome: 'pushed', contents: { summary: 'x', prUrl: 'y' } });
    const replay = await handoff(database, woken, { runId, outcome: 'passing', contents: { headSha: 'abc' } });
    expect(replay).toEqual({ alreadyAdvanced: true, runId, state: 'checks', seq: 1 });
    // Naming the new attempt moves the next step on purpose.
    expect(await handoff(database, woken, { runId, outcome: 'passing', contents: { headSha: 'abc' }, attempt: 1 }))
      .toEqual({ runId, state: 'review', attempt: 2 });
  });

  it('counts a repeated self-loop handoff once', async () => {
    const { runId } = await startedListRun();
    const call = { runId, outcome: 'retry', contents: { note: 'again' }, attempt: 0 };
    await handoff(database, await commandFor(WORKER_A), call);
    await handoff(database, await commandFor(WORKER_A), call);
    const cards = await runCards(runId);
    expect(cards.filter((row) => row.card.outcome === 'retry')).toHaveLength(1);
    expect(cards.at(-1)!.card).toMatchObject({ seq: 1, toState: 'work', answers: 0 });
  });

  it('keeps a live run whose agent sends no attempt and no run wake (feedback-triage shape) working, once per command', async () => {
    const { runId } = await startedRun();
    // A person pings the agent directly: its command cites no run card.
    const pinged = await commandFor(IMPLEMENTER, await rootMessage(OWNER, '@impy move the run on'));
    const call = { runId, outcome: 'pushed', contents: { summary: 'x', prUrl: 'y' } };
    expect(await handoff(database, pinged, call)).toEqual({ runId, state: 'checks', attempt: 1 });
    // The same command cannot also move the next step it happens to hold.
    expect(await handoff(database, pinged, { runId, outcome: 'passing', contents: { headSha: 'abc' } }))
      .toEqual({ alreadyAdvanced: true, runId, state: 'checks', seq: 1 });
    expect(await handoff(database, pinged, call)).toEqual({ runId, state: 'checks', attempt: 1 });
    expect(await runCards(runId)).toHaveLength(2);
  });
});

describe('blocked: an agent that cannot do its step hands it on', () => {
  it('moves the step to the next eligible agent with one line naming from, to and why', async () => {
    await database.query(`UPDATE identities SET handle='wa' WHERE id=$1`, [WORKER_A]);
    await database.query(`UPDATE identities SET handle='wb' WHERE id=$1`, [WORKER_B]);
    const { runId } = await startedListRun();
    // `work` requires `note`; blocked needs only its reason.
    const result = await handoff(database, await commandFor(WORKER_A), {
      runId, outcome: 'blocked', contents: { reason: 'no database write access' }, attempt: 0,
    });
    expect(result).toEqual({ runId, state: 'work', attempt: 1 });
    const last = (await runCards(runId)).at(-1)!;
    expect(last.card).toMatchObject({
      reassigned: true, answers: 0, roleBindings: { worker: WORKER_B },
      tried: [{ agentId: WORKER_A, reason: 'blocked (no database write access)' }],
    });
    expect(last.text).toBe(
      `the workflow moved work · from @wa to @wb because blocked (no database write access) in run ${runId.slice(0, 8)} of list-flow`,
    );
    expect(await pendingCommandsFor(WORKER_B)).toBeGreaterThan(0);
  });

  it('refuses blocked with no reason, and from an agent not holding the step', async () => {
    const { runId } = await startedListRun();
    await expect(handoff(database, await commandFor(WORKER_A), { runId, outcome: 'blocked', contents: {} }))
      .rejects.toThrow('blocked needs contents.reason');
    await expect(handoff(database, await commandFor(WORKER_B), { runId, outcome: 'blocked', contents: { reason: 'x' } }))
      .rejects.toThrow('bound to the worker role, not you');
  });

  it('skips unhealthy agents, then applies timeout with every agent\'s reason once the list is used up', async () => {
    await addAgent(REVIEWER);
    await reportPresence(WORKER_B, 'offline');
    const { runId } = await startedListRun([WORKER_A, WORKER_B, REVIEWER]);
    await handoff(database, await commandFor(WORKER_A), { runId, outcome: 'blocked', contents: { reason: 'no access' }, attempt: 0 });
    expect((await listRunCard(runId)).roleBindings.worker).toBe(REVIEWER);
    const result = await handoff(database, await commandFor(REVIEWER), {
      runId, outcome: 'blocked', contents: { reason: 'also no access' }, attempt: 1,
    });
    expect(result).toMatchObject({ state: 'failed', status: 'failed' });
    const last = (await runCards(runId)).at(-1)!;
    expect(last.author_id).toBe(SYSTEM_IDENTITY_ID);
    expect(last.card).toMatchObject({ fromState: 'work', outcome: 'timeout' });
    expect(last.card.contents.reason).toBe(
      '@workera blocked (no access), @workerb offline, @ravi blocked (also no access)',
    );
  });

  it('resets the tried list on every visit through an on edge, including a loop back to the same state', async () => {
    const { runId } = await startedListRun();
    await handoff(database, await commandFor(WORKER_A), { runId, outcome: 'blocked', contents: { reason: 'busy' }, attempt: 0 });
    expect((await listRunCard(runId) as any).tried).toHaveLength(1);
    await handoff(database, await commandFor(WORKER_B), { runId, outcome: 'retry', contents: { note: 'loop' }, attempt: 1 });
    const revisit = await listRunCard(runId) as any;
    expect(revisit).toMatchObject({ toState: 'work', roleBindings: { worker: WORKER_B } });
    expect(revisit.tried).toBeUndefined();
  });

  it('does not carry one state\'s tried list into the next state held by the same role', async () => {
    await addAgent(IMPLEMENTER);
    await addAgent(REVIEWER);
    const command = await commandFor(IMPLEMENTER);
    await saveWorkflow(database, command, { contract: describedWorkflow(CONTRACT) });
    const { runId } = await startWorkflow(database, command, {
      name: 'corner', roleBindings: { implementer: [IMPLEMENTER, REVIEWER], reviewer: REVIEWER, approver: APPROVER },
    });
    await handoff(database, await commandFor(IMPLEMENTER), { runId, outcome: 'blocked', contents: { reason: 'busy' }, attempt: 0 });
    await handoff(database, await commandFor(REVIEWER), { runId, outcome: 'pushed', contents: { summary: 'x', prUrl: 'y' }, attempt: 1 });
    const checks = await listRunCard(runId) as any;
    expect(checks).toMatchObject({ toState: 'checks', roleBindings: { implementer: REVIEWER } });
    expect(checks.tried).toBeUndefined();
    // Nobody after REVIEWER on the list: the engine applies timeout with each agent's reason.
    await handoff(database, await commandFor(REVIEWER), { runId, outcome: 'blocked', contents: { reason: 'red CI' }, attempt: 2 });
    const read = await getWorkflowRun(database, ROOM, runId);
    expect(read.history.at(-1)).toMatchObject({
      fromState: 'checks', outcome: 'timeout',
      contents: { reason: '@impy earlier on the list, @ravi blocked (red CI)' },
    });
  });

  it('exhausts a single-agent role on blocked and waits when its pinned older version has no timeout outcome', async () => {
    const { runId } = await startedListRun();
    await withoutTimeouts('list-flow', 'close');
    await handoff(database, await commandFor(WORKER_A), { runId, outcome: 'done', contents: { note: 'ok' }, attempt: 0 });
    const result = await handoff(database, await commandFor(APPROVER), {
      runId, outcome: 'blocked', contents: { reason: 'cannot close' }, attempt: 1,
    });
    expect(result).toEqual({ runId, state: 'close', attempt: 1 });
    const notice = (await database.query<{ text: string }>(
      `SELECT text FROM messages WHERE room_id=$1 AND text LIKE '%closer role''s list%'`, [ROOM],
    )).rows;
    expect(notice).toHaveLength(1);
    expect(notice[0]!.text).toContain('@ada blocked (cannot close)');
  });
});

describe('a result ends its turn without implicitly moving a workflow', () => {
  it('keeps the explicit workflow step after an answer and a late preceding receipt (WORKFLOW-NO-HANDOFF-1)', async () => {
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member')`,[WORKSPACE,WORKER_A]);
    await saveWorkflow(database, await commandFor(WORKER_A), { contract: describedWorkflow({
      version: 1, name: 'reply-failover', description: 'Exercise overlapping workflow turns',
      roles: ['maker', 'checker'], start: 'script', handoffs: {
        script: { role: 'maker', requires: [], on: { done: 'video', timeout: 'failed' } },
        video: { role: 'maker', requires: [], on: { done: 'finished', timeout: 'nudge' } },
        nudge: { role: 'checker', requires: [], on: { done: 'finished', timeout: 'failed' } },
        finished: { kind: 'terminal', status: 'done' }, failed: { kind: 'terminal', status: 'failed' },
      },
    }) });
    const { runId } = await startWorkflow(database, await commandFor(WORKER_A), {
      name: 'reply-failover', roleBindings: { maker: WORKER_A, checker: WORKER_B },
    });
    const daemon = new HelperDaemonService(database, new LiveHub());
    const claim = async (source: string, generationId: string) => {
      const command = (await database.query<CommandRow>(
        `SELECT * FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2`, [source, WORKER_A],
      )).rows[0]!;
      await daemon.execute('claimAgentCommand', { roomId: ROOM, commandId: command.id, generationId }, WORKER_A);
      return { roomId: ROOM, requestId: command.turn_request_id, generationId };
    };
    const previous = await claim(runId, 'script-turn');
    await daemon.execute('handoff', { ...previous, runId, outcome: 'done', contents: {}, attempt: 0 }, WORKER_A);
    const nextSource = (await runCards(runId)).at(-1)!.id;
    const next = await claim(nextSource, 'video-turn');
    await daemon.execute('postRoomMessage', { ...previous, text: 'Script ready' }, WORKER_A);
    await daemon.execute('postAgentTurnReceipt', { ...previous, status: 'complete' }, WORKER_A);
    expect((await getWorkflowRun(database, ROOM, runId)).state).toBe('video');
    await daemon.execute('postRoomMessage', { ...next, text: 'Video signup needs another approach' }, WORKER_A);
    // Only an explicit workflow handoff moves this step.
    await daemon.execute('postAgentTurnReceipt', { ...next, status: 'complete' }, WORKER_A);
    expect((await getWorkflowRun(database, ROOM, runId)).state).toBe('video');
    const cards = await runCards(runId);
    expect(cards.at(-1)!.card).toMatchObject({ toState: 'video', outcome: 'done' });
    await daemon.execute('postAgentTurnReceipt', { ...next, status: 'complete' }, WORKER_A);
    expect(await runCards(runId)).toHaveLength(cards.length);
  });
});

it('workflow silence creates no schedules and cannot move a step or gate', async () => {
  const runId = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
  expect((await database.query('SELECT id FROM agent_schedules')).rows).toEqual([]);
  expect(await new AgentScheduleLoop(database).runOnce(new Date(Date.now() + 30 * 86400_000))).toBe(0);
  expect((await getWorkflowRun(database, ROOM, runId)).state).toBe('work');
  await reachGate(runId);
  expect((await database.query('SELECT id FROM agent_schedules')).rows).toEqual([]);
  expect(await new AgentScheduleLoop(database).runOnce(new Date(Date.now() + 30 * 86400_000))).toBe(0);
  expect(await getWorkflowRun(database, ROOM, runId)).toMatchObject({ state: 'sign_off', status: 'live' });
});

describe('gates with a timeout and a default', () => {

  it('accepts event-only gates and validates an explicit default', async () => {
    const command = await commandFor(WORKER_A);
    const gate = GATED.handoffs.sign_off;
    const withGate = (sign_off: unknown) => describedWorkflow({ ...GATED, handoffs: { ...GATED.handoffs, sign_off } });
    await expect(saveWorkflow(database, command, { contract: withGate({ ...gate, default: undefined }) }))
      .resolves.toBeDefined();
    await expect(saveWorkflow(database, command, { contract: withGate({ ...gate, default: 'later' }) }))
      .rejects.toThrow('default "later" is not an outcome in on');
    await expect(saveWorkflow(database, command, {
      contract: describedWorkflow({ ...GATED, handoffs: { ...GATED.handoffs, work: { ...GATED.handoffs.work, on: { done: 'sign_off', blocked: 'failed' } } } }),
    })).rejects.toThrow('"blocked" is built in');
    await expect(saveWorkflow(database, command, { contract: describedWorkflow({ ...GATED, deadlineSeconds: 5 }) }))
      .rejects.toThrow('deadlineSeconds must be a whole number from 60 to 2592000');
  });

  it('applies the default on a person\'s Skip, with the same notice, and refuses Skip on a gate with no default', async () => {
    await database.query(`UPDATE identities SET handle='owner' WHERE id=$1`, [OWNER]);
    const runId = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    await reachGate(runId);
    await expect(answerGate(runId)).resolves.toMatchObject({ status: 'skipped' });
    expect((await getWorkflowRun(database, ROOM, runId)).history.at(-1)).toMatchObject({
      outcome: 'stop', actorId: OWNER, contents: { decision: 'stop', defaultedBy: OWNER },
    });
    expect(await ownerNotices(OWNER)).toEqual([
      `The sign_off gate of gated took its default stop · @owner skipped it in run ${runId.slice(0, 8)}`,
    ]);
    const plain = await startedRun(OWNER);
    await withoutTimeouts('corner', 'human_approve');
    await driveToApprovalGate(plain.runId);
    await expect(answerGate(plain.runId)).rejects.toThrow('this gate needs an answer');
  });

  it('refuses an answer on an old gate card after the gate was revisited', async () => {
    const runId = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    await reachGate(runId);
    const firstCard = (await database.query<{ id: string; options: { optionId: string; label: string }[] }>(
      `SELECT choice.id,choice.options FROM room_choices choice JOIN messages message ON message.id=choice.message_id
       WHERE message.card->>'runId'=$1 AND choice.status='open'`, [runId],
    )).rows[0]!;
    await answerGate(runId, 'redo');
    await reachGate(runId);
    await expect(database.transaction((db) => settleWorkflowGate(db, {
      choiceId: firstCard.id, viewerId: OWNER, optionId: firstCard.options.find((option) => option.label === 'publish')!.optionId,
    }))).rejects.toThrow('choice conflict: this gate already advanced');
    expect((await getWorkflowRun(database, ROOM, runId)).state).toBe('sign_off');
  });
});

describe('Reproduction workflow-stalls', () => {
  it('migrates an existing gate out of the ordinary choice limit', async () => {
    const runId = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    await reachGate(runId);
    // Recreate the pre-fix schema while keeping its live gate card.
    await database.query(`ALTER TABLE room_choices DROP COLUMN workflow_run_id`);
    await database.query(`CREATE UNIQUE INDEX room_choices_open_agent_room
      ON room_choices(agent_id,room_id) WHERE status='open'`);
    await migrate(database);
    await postRoomChoice(database, { roomId: ROOM, agentId: APPROVER, mode: 'question',
      prompt: 'Choose a plan', options: [
        { label: 'First', consequence: 'Use first plan' },
        { label: 'Second', consequence: 'Use second plan' },
      ] });
    expect((await database.query(`SELECT workflow_run_id FROM room_choices WHERE workflow_run_id=$1`, [runId])).rowCount).toBe(1);
  });

  it('opens gates beside an ask_choice and another workflow gate while preserving the ordinary choice limit', async () => {
    const ordinary = () => postRoomChoice(database, { roomId: ROOM, agentId: APPROVER,
      mode: 'question', prompt: 'Which plan?', options: [{ label: 'First', consequence: 'Use first plan' }, { label: 'Second', consequence: 'Use second plan' }] });
    await ordinary();
    const runId = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    await reachGate(runId);
    await saveWorkflow(database, await commandFor(WORKER_A), { contract: describedWorkflow({ ...GATED, name: 'second-gate' }) });
    const second = await startWorkflow(database, await commandFor(WORKER_A), {
      name: 'second-gate', roleBindings: { worker: WORKER_A, approver: APPROVER },
    });
    await reachGate(second.runId);
    expect((await database.query(`SELECT id FROM room_choices WHERE status='open' AND agent_id=$1`, [APPROVER])).rowCount).toBe(3);
    await expect(ordinary()).rejects.toThrow('already have an open choice');
    console.log('Demonstrated workflow-stalls-2: two gates and one ordinary choice coexist; another ordinary choice is refused');
  });

  it('commits a completed turn even when its workflow contract is missing', async () => {
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member')`,[WORKSPACE,WORKER_A]);
    const { runId } = await startedListRun();
    const command = (await database.query<CommandRow>(`SELECT * FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2`, [runId, WORKER_A])).rows[0]!;
    const generationId = 'workflow-stalls-3';
    const daemon = new HelperDaemonService(database, new LiveHub());
    await daemon.execute('claimAgentCommand', { roomId: ROOM, commandId: command.id, generationId }, WORKER_A);
    await database.query(`DELETE FROM workspace_skills WHERE slug='list-flow'`);
    await daemon.execute('postAgentTurnReceipt', { roomId: ROOM, requestId: command.turn_request_id,
      generationId, status: 'complete' }, WORKER_A);
    expect((await database.query(`SELECT state FROM agent_commands WHERE id=$1`, [command.id])).rows[0]).toMatchObject({ state: 'complete' });
    expect((await database.query(`SELECT status FROM agent_turns WHERE request_id=$1`, [command.turn_request_id])).rows[0]).toMatchObject({ status: 'complete' });
    console.log('Demonstrated workflow-stalls-3: missing contract did not prevent the completion receipt or command completion');
  });

  it.each(['server', 'waiting', 'roleBinding', 'implicitEdges', 'externalOutcomes'])('rejects corner-only %s on save', async (field) => {
    const contract = describedWorkflow(GATED) as any;
    if (field === 'server') contract.handoffs.work = { kind: 'server', does: 'Run', requires: [], on: { done: 'sign_off' } };
    if (field === 'waiting') {
      contract.handoffs.sign_off = { kind: 'waiting', does: 'Wait' };
      contract.handoffs.work.on = { done: 'sign_off', finished: 'land', timeout: 'failed' };
    }
    if (field === 'roleBinding') contract.handoffs.work.roleBinding = 'live:parent.worker_agent_id';
    if (field === 'implicitEdges') contract.implicitEdges = ['land'];
    if (field === 'externalOutcomes') contract.externalOutcomes = ['done'];
    await expect(saveWorkflow(database, await commandFor(WORKER_A), { contract })).rejects.toThrow(/corner-only/);
    console.log(`Demonstrated workflow-stalls-4: save rejected ${field}`);
  });
});

describe('Reproduction run-status: one saved status for every reader', () => {
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

  async function everyEnding(): Promise<Record<'done' | 'failed' | 'cancelled', string>> {
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

    const cancelled = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    await cancelWorkflowRun(database, { room_id: ROOM, agent_id: OWNER } as CommandRow, { runId: cancelled, reason: 'stop' });
    await expectStatus(cancelled, 'abandoned');
    return { done, failed, cancelled };
  }

  it('saves the status at start, on each move and at every ending, and every live check agrees', async () => {
    await everyEnding();
    console.log('Demonstrated run-status: start, handoff, done, failed, deadline and cancel each saved one status that every reader and live check returned');
  });

  it('fills a missing or legacy saved status from the run itself and drops the retired flag', async () => {
    const runs = await everyEnding();
    const live = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    await reachGate(live);
    const all = [...Object.values(runs), live];
    // Legacy start cards: no saved status, or a stale `active` written by an older release.
    await database.query(`UPDATE messages SET card=card-'runStatus' || '{"active":true}'::jsonb WHERE id=ANY($1::text[])`, [[runs.done, live]]);
    await database.query(`UPDATE messages SET card=card || '{"active":true}'::jsonb WHERE id=$1`, [runs.failed]);
    await database.query(`UPDATE messages SET card=card-'runStatus' WHERE id=$1`, [runs.cancelled]);
    expect(await saveUnsavedWorkflowRunStatus(database)).toBe(4);
    expect(await saveUnsavedWorkflowRunStatus(database)).toBe(0);
    await expectStatus(runs.done, 'done');
    await expectStatus(runs.failed, 'failed');
    await expectStatus(runs.cancelled, 'abandoned');
    await expectStatus(live, 'live');
    expect((await database.query(`SELECT 1 FROM messages WHERE id=ANY($1::text[]) AND card ? 'active'`, [all])).rowCount).toBe(0);
  });

  it('reads live runs through a partial workflow index on the saved status or start cards', async () => {
    await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    await database.query(`SET enable_seqscan=off`);
    try {
      const plan = async (sql: string) => JSON.stringify(
        (await database.query<Record<string, unknown>>(`EXPLAIN (FORMAT JSON) ${sql}`)).rows[0]?.['QUERY PLAN']);
      expect(await plan(`SELECT id FROM messages WHERE room_id='${ROOM}' AND card_type='workflow-handoff'
        AND ${workflowRunIsLiveSql('card')} AND card->>'workflowSlug'='gated'`)).toContain('messages_workflow_run_live_idx');
      // An unscoped status sweep can use either partial index. The new start
      // index also contains exactly the start cards this predicate requests;
      // the Room-scoped check above still proves the saved-live index is used.
      expect(await plan(`SELECT id FROM messages WHERE card_type='workflow-handoff' AND id=card->>'runId'
        AND ${workflowRunIsLiveSql('card')}`)).toMatch(/messages_workflow_run_(live|start)_idx/);
      expect(await plan(`SELECT id FROM messages WHERE card_type='workflow-handoff'
        AND ${workflowRunStatusUnsavedSql('card', 'id')}`)).toContain('messages_workflow_run_status_backfill_idx');
    } finally {
      await database.query(`SET enable_seqscan=on`);
    }
  });
});

describe('workflow timeout recovery reproductions', () => {
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

  it('Reproduction wf-1: declared timeout accepts reason without vault_reference, preserving success validation', async () => {
    const { runId } = await signupRun();
    const command = await commandFor(WORKER_A);
    await expect(handoff(database, command, { runId, outcome: 'ready', contents: { reason: 'No key' } }))
      .rejects.toThrow('vault_reference is required');
    await expect(handoff(database, command, { runId, outcome: 'unknown', contents: { reason: 'No key' } }))
      .rejects.toThrow('invalid outcome');
    for (const contents of [{}, { reason: '' }, { reason: 42 }, { reason: 'x'.repeat(501) }, { reason: 'No key', extra: 'x'.repeat(16384) }, null]) {
      await expect(handoff(database, command, { runId, outcome: 'timeout', contents })).rejects.toThrow();
    }
    await expect(handoff(database, command, { runId, outcome: 'timeout',
      contents: { reason: 'Provider key does not exist' } })).resolves.toMatchObject({ state: 'recover' });
    expect(await getWorkflowRun(database, ROOM, runId)).toMatchObject({ state: 'recover' });
  });

  it('Reproduction wf-2: directed recovery rebinds maker at owner gate without allowing agent gate answers', async () => {
    const { runId } = await signupRun();
    await handoff(database, await commandFor(WORKER_A), {
      runId, outcome: 'blocked', contents: { reason: 'Provider signup exhausted' },
    });
    expect(await getWorkflowRun(database, ROOM, runId)).toMatchObject({ state: 'recover' });
    const directed = await adminCommand();
    await expect(assignWorkflowRole(database, directed, { runId, role: 'maker', targetAgentId: WORKER_B }))
      .resolves.toMatchObject({ state: 'recover' });
    const read = await getWorkflowRun(database, ROOM, runId);
    expect(read).toMatchObject({ state: 'recover', boundAgentId: APPROVER });
    await expect(assignWorkflowRole(database, directed, { runId, role: 'missing', targetAgentId: WORKER_B }))
      .rejects.toThrow('role');
    await expect(handoff(database, await commandFor(APPROVER), {
      runId, outcome: 'retry', contents: { decision: 'retry' },
    })).rejects.toThrow();
    await answerGate(runId, 'retry');
    expect(await getWorkflowRun(database, ROOM, runId)).toMatchObject({ state: 'signup_stills', boundAgentId: WORKER_B });
    await expect(handoff(database, await commandFor(WORKER_B), {
      runId, outcome: 'ready', contents: { vault_reference: 'vault://provider/key' },
    })).resolves.toMatchObject({ status: 'done' });
  });
});
