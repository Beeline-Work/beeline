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
import { flushDueCommanderWakes } from './commander-wakes.js';
import { FEEDBACK_TRIAGE_CONTRACT } from './feedback-triage-workflow.js';
import { activeRunIdsForSchedule, assignWorkflowRole, backfillWorkflowRunTimers, backfillWorkflowSkillDescriptions, describedLegacyWorkflowContract, handoff, getWorkflowRun, cancelWorkflowRun, liveWorkflowRun, failOverUnansweredTurn, reassignFailedWorkflowRole, saveWorkflow, settleWorkflowGate, startWorkflow, WORKFLOW_LEGACY_STEP_TIMEOUT_SECONDS } from './workflow-runs.js';
import { APPROVER, CONTRACT, GATED, IMPLEMENTER, LIST_CONTRACT, OUTSIDER, OWNER, REVIEWER, ROOM, RecordingDatabase, WORKER_A, WORKER_B, WORKSPACE, addAgent, adminCommand, answerGate, commandFor, database, driveToApprovalGate, fireTimer, listRunCard, ownerNotices, pendingCommandsFor, reachGate, reportPresence, rootMessage, runCards, startedGatedRun, startedListRun, startedRun, withoutTimeouts } from './test-fixtures/workflow-runs.js';

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
  it('uses an absorbed workflow wake’s attempt when a private-headed digest omits attempt', async () => {
    await database.query('INSERT INTO agents(agent_id,owner_id,wake_batch_minutes) VALUES($1,$2,2)', [IMPLEMENTER, OWNER]);
    await createAgentCommand(database, { roomId: ROOM, agentId: IMPLEMENTER, sourceMessageId: null,
      reason: 'corner_brief', privatePayload: { text: 'Unrelated lifecycle head', authorId: REVIEWER, fromRoomId: ROOM, kind: 'lifecycle' } });
    const { runId } = await startedRun();
    await database.query('UPDATE agent_commands SET wake_after=now() WHERE wake_after IS NOT NULL');
    await flushDueCommanderWakes(database);
    const digest = (await readAgentCommands(database, ROOM, IMPLEMENTER)).commands[0]!;
    const claimed = await database.transaction(tx => claimAgentCommand(tx, ROOM, IMPLEMENTER, digest.id, 'digest-attempt'));
    await handoff(database, claimed, {
      runId, outcome: 'pushed', contents: { summary: 'Advanced the first step', prUrl: 'https://test/pr/1' }, attempt: 0,
    });
    expect(await handoff(database, claimed, { runId, outcome: 'passing', contents: { headSha: 'old-work' } }))
      .toEqual({ alreadyAdvanced: true, runId, state: 'checks', seq: 1 });
    expect((await getWorkflowRun(database, ROOM, runId)).state).toBe('checks');
    console.info('Demonstrated inbox-workflow-attempt: an absorbed attempt 0 cannot advance the newer visit when a digest handoff omits attempt');
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

  it('cancels pending wakes of older attempts on advance and on reassignment', async () => {
    const { runId } = await startedListRun();
    const pendingFromRun = async (agentId: string) => Number((await database.query<{ count: string }>(
      `SELECT count(*)::text count FROM agent_commands command JOIN messages message ON message.id=command.source_message_id
       WHERE command.agent_id=$1 AND command.state='pending' AND message.card->>'runId'=$2`,
      [agentId, runId],
    )).rows[0]!.count);
    expect(await pendingFromRun(WORKER_A)).toBe(1);
    await reassignFailedWorkflowRole(database, { roomId: ROOM, requestId: runId, agentId: WORKER_A });
    expect(await pendingFromRun(WORKER_A)).toBe(0);
    expect(await pendingFromRun(WORKER_B)).toBe(1);
    await handoff(database, await commandFor(WORKER_B), { runId, outcome: 'done', contents: { note: 'ok' }, attempt: 1 });
    expect(await pendingFromRun(WORKER_B)).toBe(0);
    expect(await pendingFromRun(APPROVER)).toBe(1);
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

describe('no handoff: a turn that answered the step and ended without moving it', () => {
  it('advances after a reply completed the next state wake, while the previous turn finishes late (WORKFLOW-NO-HANDOFF-1)', async () => {
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
    const daemon = new DaemonService(database, new LiveHub());
    const claim = async (source: string, generationId: string) => {
      const command = (await database.query<CommandRow>(
        `SELECT * FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2`, [source, WORKER_A],
      )).rows[0]!;
      await claimAgentCommand(database, ROOM, WORKER_A, command.id, generationId);
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
    // Publishing completes the command; the receipt must still run failover.
    await daemon.execute('postAgentTurnReceipt', { ...next, status: 'complete' }, WORKER_A);
    expect((await getWorkflowRun(database, ROOM, runId)).state).toBe('nudge');
    const cards = await runCards(runId);
    expect(cards.at(-1)!.text).toContain('its turn ended with no handoff');
    expect(cards.at(-1)!.card).toMatchObject({ toState: 'nudge', outcome: 'timeout' });
    expect((await database.query(`SELECT id FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2 AND state='pending'`,
      [cards.at(-1)!.id, WORKER_B])).rowCount).toBe(1);
    await daemon.execute('postAgentTurnReceipt', { ...next, status: 'complete' }, WORKER_A);
    expect(await runCards(runId)).toHaveLength(cards.length);
  });

  it('moves the step to the next agent with reason no handoff', async () => {
    const { runId } = await startedListRun();
    await failOverUnansweredTurn(database, { roomId: ROOM, agentId: WORKER_A, sourceMessageId: runId });
    const card = await listRunCard(runId) as any;
    expect(card).toMatchObject({ seq: 1, roleBindings: { worker: WORKER_B } });
    expect(card.tried).toEqual([{ agentId: WORKER_A, reason: 'its turn ended with no handoff' }]);
  });

  it('ignores a turn that handed off, a stale wake, and an unrelated turn by the same agent', async () => {
    const { runId } = await startedListRun();
    const unrelated = await rootMessage(OWNER, '@workera what time is it');
    await failOverUnansweredTurn(database, { roomId: ROOM, agentId: WORKER_A, sourceMessageId: unrelated });
    expect((await listRunCard(runId)).seq).toBe(0);
    await handoff(database, await commandFor(WORKER_A, runId), { runId, outcome: 'retry', contents: { note: 'again' } });
    // The turn's wake (attempt 0) is no longer current: its end changes nothing.
    await failOverUnansweredTurn(database, { roomId: ROOM, agentId: WORKER_A, sourceMessageId: runId });
    expect(await listRunCard(runId)).toMatchObject({ seq: 1, roleBindings: { worker: WORKER_A } });
  });

  it('applies timeout at once for a single-agent role', async () => {
    const { runId } = await startedListRun(WORKER_A);
    await failOverUnansweredTurn(database, { roomId: ROOM, agentId: WORKER_A, sourceMessageId: runId });
    const read = await getWorkflowRun(database, ROOM, runId);
    expect(read).toMatchObject({ state: 'failed', status: 'failed' });
    expect(read.history.at(-1)).toMatchObject({ outcome: 'timeout', contents: { reason: '@workera its turn ended with no handoff' } });
  });
});

describe('engine step expiry', () => {
  it('lets exactly one of a handoff and an expiry for the same attempt win, in either order', async () => {
    const first = await startedListRun();
    await handoff(database, await commandFor(WORKER_A), { runId: first.runId, outcome: 'done', contents: { note: 'ok' }, attempt: 0 });
    // The handoff won: the timer it replaced is gone, and a stale one does nothing.
    await database.query(
      `INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,max_runs,next_run_at,workflow_run)
       VALUES($1,$2,$3,$4,$4,'{"kind":"interval","everyMinutes":1}'::jsonb,'stale',1,now(),$5::jsonb)`,
      [randomUUID(), WORKSPACE, ROOM, SYSTEM_IDENTITY_ID, JSON.stringify({ runId: first.runId, workflowSlug: 'list-flow', timer: 'step', attempt: 0 })],
    );
    expect(await new AgentScheduleLoop(database).runOnce()).toBe(0);
    expect((await listRunCard(first.runId)).toState).toBe('close');
    await cancelWorkflowRun(database, await commandFor(IMPLEMENTER), { runId: first.runId, reason: 'next case' });

    const second = await startedListRun();
    expect(await fireTimer(second.runId, 'step')).toBe(1);
    // The expiry won: WORKER_A's late handoff for attempt 0 changes nothing.
    expect(await handoff(database, await commandFor(WORKER_A), {
      runId: second.runId, outcome: 'done', contents: { note: 'late' }, attempt: 0,
    })).toEqual({ alreadyAdvanced: true, runId: second.runId, state: 'work', seq: 1 });
    expect((await listRunCard(second.runId)).roleBindings.worker).toBe(WORKER_B);
  });

  it('fires for an agent that was removed from the Room', async () => {
    const { runId } = await startedListRun();
    await database.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [ROOM, WORKER_A]);
    expect(await fireTimer(runId, 'step')).toBe(1);
    expect((await listRunCard(runId)).roleBindings.worker).toBe(WORKER_B);
  });

  it('survives a restart: a new scheduler loop finds and fires the stored timer', async () => {
    const { runId } = await startedListRun();
    const loop = new AgentScheduleLoop(database);
    const due = await loop.nextDueAt();
    expect(due!.getTime()).toBeGreaterThan(Date.now() + 3_500_000);
    expect(await new AgentScheduleLoop(database).runOnce(new Date(Date.now() + 3_700_000))).toBe(1);
    expect((await listRunCard(runId)).roleBindings.worker).toBe(WORKER_B);
  });

  it('fails over a turn that failed after it was woken by an expiry move', async () => {
    await addAgent(REVIEWER);
    const { runId } = await startedListRun([WORKER_A, WORKER_B, REVIEWER]);
    await fireTimer(runId, 'step');
    const expiryMove = (await runCards(runId)).at(-1)!;
    expect(expiryMove.card.roleBindings.worker).toBe(WORKER_B);
    await reassignFailedWorkflowRole(database, { roomId: ROOM, requestId: expiryMove.id, agentId: WORKER_B, reason: 'provider error' });
    const card = await listRunCard(runId) as any;
    expect(card.roleBindings.worker).toBe(REVIEWER);
    expect(card.tried).toEqual([
      { agentId: WORKER_A, reason: 'its lease expired' },
      { agentId: WORKER_B, reason: 'its turn failed (provider error)' },
    ]);
    // A failure reported against the older wake is stale and changes nothing.
    await reassignFailedWorkflowRole(database, { roomId: ROOM, requestId: expiryMove.id, agentId: WORKER_B });
    expect((await listRunCard(runId)).seq).toBe(2);
  });

  it('fails over a failed turn woken by another wake citing the current attempt', async () => {
    const { runId } = await startedListRun();
    const wake = await rootMessage(OWNER, 'run reminder');
    await database.query(`UPDATE messages SET card=$2::jsonb,created_at=now()+interval '1 second' WHERE id=$1`, [wake, JSON.stringify({ runId })]);
    await reassignFailedWorkflowRole(database, { roomId: ROOM, requestId: wake, agentId: WORKER_A });
    expect((await listRunCard(runId)).roleBindings.worker).toBe(WORKER_B);
  });
});

describe('gates with a timeout and a default', () => {
  it('refuses a new save whose agent step has no timeout or whose gate has no timeout and default', async () => {
    const command = await commandFor(WORKER_A);
    const without = (name: string, ...keys: string[]) => ({ ...GATED, handoffs: { ...GATED.handoffs,
      [name]: Object.fromEntries(Object.entries(GATED.handoffs[name as 'work']).filter(([key]) => !keys.includes(key))) } });
    const described = (contract: unknown) => ({ ...(contract as object), summary: 'Work and sign off.',
      handoffs: Object.fromEntries(Object.entries((contract as typeof GATED).handoffs).map(([name, state]) => [name, { does: `Do ${name}.`, ...state }])) });
    const timedWork = { ...GATED.handoffs.work, on: { done: 'sign_off', timeout: 'failed' }, timeoutSeconds: 600 };
    const compliant = { ...GATED, handoffs: { ...GATED.handoffs, work: timedWork } };
    await expect(saveWorkflow(database, command, { contract: described(GATED) }))
      .rejects.toThrow('handoffs.work: timeoutSeconds is required, with a "timeout" outcome in on');
    await expect(saveWorkflow(database, command, { contract: described({ ...without('sign_off', 'default', 'timeoutSeconds'), handoffs: { ...without('sign_off', 'default', 'timeoutSeconds').handoffs, work: timedWork } }) }))
      .rejects.toThrow('handoffs.sign_off: a gate needs timeoutSeconds and default');
    await expect(saveWorkflow(database, command, { contract: described(compliant) })).resolves.toMatchObject({ slug: 'gated' });
  });

  it('validates timeoutSeconds and default together on new saves', async () => {
    const command = await commandFor(WORKER_A);
    const gate = GATED.handoffs.sign_off;
    const withGate = (sign_off: unknown) => describedWorkflow({ ...GATED, handoffs: { ...GATED.handoffs, sign_off } });
    await expect(saveWorkflow(database, command, { contract: withGate({ ...gate, default: undefined }) }))
      .rejects.toThrow('a gate declares timeoutSeconds and default together, or neither');
    await expect(saveWorkflow(database, command, { contract: withGate({ ...gate, default: 'later' }) }))
      .rejects.toThrow('default "later" is not an outcome in on');
    await expect(saveWorkflow(database, command, {
      contract: describedWorkflow({ ...GATED, handoffs: { ...GATED.handoffs, work: { ...GATED.handoffs.work, on: { done: 'sign_off', blocked: 'failed' } } } }),
    })).rejects.toThrow('"blocked" is built in');
    await expect(saveWorkflow(database, command, { contract: describedWorkflow({ ...GATED, deadlineSeconds: 5 }) }))
      .rejects.toThrow('deadlineSeconds must be a whole number from 60 to 2592000');
  });

  it('applies the default when unanswered, with exactly one notice to the person who started the run', async () => {
    await database.query(`UPDATE identities SET handle='owner' WHERE id=$1`, [OWNER]);
    const runId = await startedGatedRun(await commandFor(WORKER_A, await rootMessage(OWNER, '@wa run gated')));
    await reachGate(runId);
    expect(await fireTimer(runId, 'step')).toBe(1);
    const read = await getWorkflowRun(database, ROOM, runId);
    expect(read).toMatchObject({ state: 'failed', status: 'failed' });
    expect(read.history.at(-1)).toMatchObject({
      fromState: 'sign_off', outcome: 'stop', actorId: SYSTEM_IDENTITY_ID,
      contents: { decision: 'stop', defaultedBy: 'system' },
    });
    expect(read.history.at(-1)).toBeDefined();
    const line = (await runCards(runId)).at(-1)!.text;
    expect(line).toBe(`the workflow applied stop · at sign_off and went to failed because nobody answered in 10 min in run ${runId.slice(0, 8)} of gated`);
    expect(await ownerNotices(OWNER)).toEqual([
      `The sign_off gate of gated took its default stop · nobody answered in 10 min in run ${runId.slice(0, 8)}`,
    ]);
    expect(await fireTimer(runId, 'step')).toBe(0);
    expect(await ownerNotices(OWNER)).toHaveLength(1);
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

  it('lets exactly one of an answer and the expiry win', async () => {
    const answered = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    await reachGate(answered);
    await answerGate(answered, 'publish');
    expect(await fireTimer(answered, 'step')).toBe(0);
    expect((await getWorkflowRun(database, ROOM, answered)).state).toBe('land');

    const expired = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    await reachGate(expired);
    const card = (await database.query<{ id: string; options: { optionId: string; label: string }[] }>(
      `SELECT choice.id,choice.options FROM room_choices choice JOIN messages message ON message.id=choice.message_id
       WHERE message.card->>'runId'=$1`, [expired],
    )).rows[0]!;
    expect(await fireTimer(expired, 'step')).toBe(1);
    await expect(database.transaction((db) => settleWorkflowGate(db, {
      choiceId: card.id, viewerId: OWNER, optionId: card.options.find((option) => option.label === 'publish')!.optionId,
    }))).rejects.toThrow('choice conflict');
    expect((await getWorkflowRun(database, ROOM, expired)).state).toBe('failed');
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

  it('sends the notice to the Workspace admins when the owner has left the Room', async () => {
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner')`, [WORKSPACE, OWNER]);
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WORKSPACE, ROOM, OUTSIDER]);
    const runId = await startedGatedRun(await commandFor(WORKER_A, await rootMessage(OUTSIDER, 'please run gated')));
    expect((await runCards(runId))[0]!.card.ownerId).toBe(OUTSIDER);
    await database.query(`UPDATE memberships SET removed_at=now() WHERE room_id=$1 AND identity_id=$2`, [ROOM, OUTSIDER]);
    await reachGate(runId);
    await fireTimer(runId, 'step');
    expect(await ownerNotices(OWNER)).toHaveLength(1);
    expect(await ownerNotices(OUTSIDER)).toHaveLength(0);
  });
});

describe('legacy run timer recovery', () => {
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

  it('Reproduction legacy-timers: closes an overdue legacy gate once and lets the next schedule tick start a run', async () => {
    const runId = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    await withoutTimeouts('gated', 'sign_off');
    await reachGate(runId);
    await database.query(`DELETE FROM agent_schedules WHERE workflow_run->>'runId'=$1`, [runId]);
    await database.query(
      `UPDATE messages SET created_at=now()-interval '3 hours',card=card-'deadlineSeconds'-'seq' WHERE id=$1`, [runId],
    );
    const scheduleId = '30000000-0000-4000-8000-000000000005';
    await database.query(
      `INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at,workflow_slug)
       VALUES($1,$2,$3,$4,$5,'{"kind":"interval","everyMinutes":60}'::jsonb,'run gated',now()-interval '1 minute','gated')`,
      [scheduleId, WORKSPACE, ROOM, WORKER_B, OWNER],
    );
    expect(await new AgentScheduleLoop(database).runOnce()).toBe(1);
    const skips = (await database.query<{ text: string }>(
      `SELECT text FROM messages WHERE room_id=$1 AND text LIKE '%skipped a run%'`, [ROOM],
    )).rows;
    expect(skips).toEqual([{ text: `The gated schedule skipped a run · run ${runId} is active at step sign_off in state live for 180 min` }]);
    expect(await new AgentScheduleLoop(database).runOnce(new Date(Date.now() + 30_000))).toBe(0);
    expect((await getWorkflowRun(database, ROOM, runId)).status).toBe('live');
    console.log('Reproduction legacy-timers: overdue gate stayed live without timers; schedule skipped at sign_off');

    await migrateData(database);
    const timers = (await database.query<{ timer: string }>(
      `SELECT workflow_run->>'timer' timer FROM agent_schedules WHERE workflow_run->>'runId'=$1`, [runId],
    )).rows;
    expect(timers).toEqual([{ timer: 'deadline' }]);
    expect(await new AgentScheduleLoop(database).runOnce(new Date(Date.now() + 30_000))).toBe(1);
    const closed = await getWorkflowRun(database, ROOM, runId);
    expect(closed).toMatchObject({ state: 'sign_off', status: 'failed' });
    expect(closed.history.at(-1)).toMatchObject({ outcome: 'deadline', contents: { reason: 'deadline' } });
    expect((await runCards(runId)).filter((row) => row.card.closure)).toHaveLength(1);
    await migrateData(database);
    expect(await new AgentScheduleLoop(database).runOnce(new Date(Date.now() + 30_000))).toBe(0);
    expect((await runCards(runId)).filter((row) => row.card.closure)).toHaveLength(1);

    await database.query(`UPDATE agent_schedules SET next_run_at=now()-interval '1 minute' WHERE id=$1`, [scheduleId]);
    expect(await new AgentScheduleLoop(database).runOnce()).toBe(1);
    const scheduled = (await database.query<CommandRow>(
      `SELECT * FROM agent_commands WHERE reason='schedule' AND agent_id=$1 ORDER BY created_at DESC LIMIT 1`, [WORKER_B],
    )).rows[0]!;
    const fresh = await startWorkflow(database, scheduled, { name: 'gated', roleBindings: { worker: WORKER_A, approver: APPROVER } });
    expect(fresh.runId).not.toBe(runId);
    expect(fresh.state).toBe('work');
    console.log('Demonstrated legacy-timers: deadline closed the gate once; the next schedule tick started a fresh run');
  });

  it('Reproduction orphaned-run: migrates a healthy legacy run alongside an unreadable run', async () => {
    const orphaned = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    await reachGate(orphaned);
    const { runId } = await startedListRun();
    await removeStepTimeout('list-flow', 'work');
    await database.query(`DELETE FROM agent_schedules WHERE workflow_run->>'runId'=ANY($1::text[])`, [[orphaned, runId]]);
    await database.query(`UPDATE messages SET card=card-'runStatus' WHERE id=ANY($1::text[])`, [[orphaned, runId]]);
    await database.query(`DELETE FROM workspace_skills WHERE slug='gated'`);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(migrateData(database)).resolves.toBeUndefined();
      expect(errors).toHaveBeenCalledWith(
        `backfillWorkflowRunTimers: failed to recover run ${orphaned}`,
        expect.objectContaining({ message: 'workflow contract version is unavailable' }),
      );
      const timers = await timersFor(runId);
      expect(timers.map((row) => row.workflow_run.timer)).toEqual(['deadline', 'step']);
      expect(await timersFor(orphaned)).toEqual([]);
      await expect(migrateData(database)).resolves.toBeUndefined();
      expect(await timersFor(runId)).toEqual(timers);
      expect(await timersFor(orphaned)).toEqual([]);
      console.log('Demonstrated orphaned-run: boot migration completed despite a missing contract; the healthy legacy run received deadline and step timers, unchanged on repeat boot');
    } finally {
      errors.mockRestore();
    }
  });

  it('gives a legacy current attempt a full lease, fails over, and takes its declared timeout after exhaustion', async () => {
    const { runId } = await startedListRun();
    await removeStepTimeout('list-flow', 'work');
    await database.query(`DELETE FROM agent_schedules WHERE workflow_run->>'runId'=$1`, [runId]);
    await database.query(
      `UPDATE messages SET card=card-'seq'-'deadlineSeconds'-'runStatus',created_at=now()-interval '2 hours' WHERE id=$1`, [runId],
    );
    await normalizeLegacyWorkflowRuns(database);
    expect(await saveUnsavedWorkflowRunStatus(database)).toBe(1);
    const before = Date.now();
    expect(await backfillWorkflowRunTimers(database)).toBe(2);
    const timers = await timersFor(runId);
    expect(timers.map((row) => row.workflow_run)).toEqual([
      { runId, workflowSlug: 'list-flow', timer: 'deadline' },
      { runId, workflowSlug: 'list-flow', timer: 'step', attempt: 0 },
    ]);
    expect(timers[1]!.next_run_at.getTime()).toBeGreaterThanOrEqual(before + WORKFLOW_LEGACY_STEP_TIMEOUT_SECONDS * 1000);
    // The 24 h deadline is measured from the original start, not the recovery.
    const start = (await database.query<{ created_at: Date }>(`SELECT created_at FROM messages WHERE id=$1`, [runId])).rows[0]!;
    expect(timers[0]!.next_run_at.getTime()).toBe(start.created_at.getTime() + 86_400_000);
    expect(await new AgentScheduleLoop(database).runOnce(new Date(before + 30_000))).toBe(0);
    expect(await backfillWorkflowRunTimers(database)).toBe(0);
    expect(await timersFor(runId)).toEqual(timers);

    expect(await fireTimer(runId, 'step')).toBe(1);
    expect(await listRunCard(runId)).toMatchObject({ seq: 1, roleBindings: { worker: WORKER_B } });
    const next = await timersFor(runId);
    expect(next[1]!.workflow_run.attempt).toBe(1);
    expect(next[1]!.next_run_at.getTime()).toBeGreaterThan(Date.now() + 3_500_000);
    expect(await fireTimer(runId, 'step')).toBe(1);
    const ended = await getWorkflowRun(database, ROOM, runId);
    expect(ended).toMatchObject({ state: 'failed', status: 'failed' });
    expect(ended.history.at(-1)).toMatchObject({ outcome: 'timeout' });
    expect(await backfillWorkflowRunTimers(database)).toBe(0);
    expect(await timersFor(runId)).toEqual([]);
  });

  it('arms the default for newly dispatched legacy steps and retries a step without a timeout outcome', async () => {
    await saveWorkflow(database, await commandFor(WORKER_A), { contract: describedWorkflow(LIST_CONTRACT) });
    await withoutTimeouts('list-flow', 'work');
    const { runId } = await startWorkflow(database, await commandFor(WORKER_A), {
      name: 'list-flow', roleBindings: { worker: WORKER_A, closer: APPROVER },
    });
    const timers = await timersFor(runId);
    expect(timers[1]!.workflow_run).toMatchObject({ timer: 'step', attempt: 0 });
    expect(timers[1]!.next_run_at.getTime()).toBeGreaterThan(Date.now() + 3_500_000);
    expect(await fireTimer(runId, 'step')).toBe(1);
    expect((await getWorkflowRun(database, ROOM, runId)).status).toBe('live');
    expect((await timersFor(runId)).map((row) => row.workflow_run.timer)).toEqual(['deadline', 'step']);
    expect(await fireTimer(runId, 'deadline')).toBe(1);
    expect((await getWorkflowRun(database, ROOM, runId)).status).toBe('failed');
  });

  it('uses the pinned deadline, preserves existing declared timers, and takes the run lock before reading its head', async () => {
    const runId = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    await reachGate(runId);
    const gateTimer = (await timersFor(runId))[1]!;
    await database.query(`DELETE FROM agent_schedules WHERE workflow_run->>'runId'=$1 AND workflow_run->>'timer'='deadline'`, [runId]);
    await database.query(`UPDATE messages SET created_at=now()-interval '1 hour',card=card-'deadlineSeconds' WHERE id=$1`, [runId]);
    await saveWorkflow(database, await adminCommand(), { contract: describedWorkflow({ ...GATED, deadlineSeconds: 14_400 }) });
    const versions = (await database.query(`SELECT markdown,content_hash FROM workspace_skill_versions ORDER BY version`)).rows;
    const recorded = new RecordingDatabase(database);
    expect(await backfillWorkflowRunTimers(recorded)).toBe(1);
    const lock = recorded.calls.findIndex((call) => call.sql.includes('pg_advisory_xact_lock'));
    const head = recorded.calls.findIndex((call) => call.sql.includes('ORDER BY (card'));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(head).toBeGreaterThan(lock);
    const timers = await timersFor(runId);
    const start = (await database.query<{ created_at: Date }>(`SELECT created_at FROM messages WHERE id=$1`, [runId])).rows[0]!;
    expect(timers[0]!.next_run_at.getTime()).toBe(start.created_at.getTime() + 7_200_000);
    expect(timers[1]).toEqual(gateTimer);
    expect(await backfillWorkflowRunTimers(database)).toBe(0);
    expect(await timersFor(runId)).toEqual(timers);
    expect((await database.query(`SELECT markdown,content_hash FROM workspace_skill_versions ORDER BY version`)).rows).toEqual(versions);
  });

  it('does not arm ended or cancelled legacy runs whose start cards lacked a saved status', async () => {
    const ended = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    await reachGate(ended);
    await answerGate(ended, 'publish');
    const cancelled = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    await cancelWorkflowRun(database, { room_id: ROOM, agent_id: OWNER } as CommandRow, { runId: cancelled, reason: 'stop' });
    await database.query(`UPDATE messages SET card=card-'runStatus' WHERE id=ANY($1::text[])`, [[ended, cancelled]]);
    expect(await saveUnsavedWorkflowRunStatus(database)).toBe(2);
    expect(await backfillWorkflowRunTimers(database)).toBe(0);
    expect(await backfillWorkflowRunTimers(database)).toBe(0);
    expect(await timersFor(ended)).toEqual([]);
    expect(await timersFor(cancelled)).toEqual([]);
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

  it('keeps a pinned corner-only waiting state readable and closes it at its deadline', async () => {
    await saveWorkflow(database, await commandFor(WORKER_A), { contract: describedWorkflow(GATED) });
    const legacy = describedWorkflow(GATED) as any;
    legacy.handoffs.work.on = { done: 'sign_off', finished: 'land', timeout: 'failed' };
    legacy.handoffs.sign_off = { kind: 'waiting', does: 'Wait for an outside event' };
    await database.query(`UPDATE workspace_skill_versions version SET markdown=$1
      FROM workspace_skills skill WHERE skill.id=version.skill_id AND skill.slug='gated'`, [JSON.stringify(legacy)]);
    const { runId } = await startWorkflow(database, await commandFor(WORKER_A), {
      name: 'gated', roleBindings: { worker: WORKER_A, approver: APPROVER },
    });
    await reachGate(runId);
    expect((await getWorkflowRun(database, ROOM, runId)).state).toBe('sign_off');
    expect(await fireTimer(runId, 'deadline')).toBe(1);
    expect((await getWorkflowRun(database, ROOM, runId)).status).toBe('failed');
    console.log('Demonstrated workflow-stalls-4: pinned waiting state still loads and its deadline closes the run');
  });

  it('isolates a throwing timer from another timer and ordinary schedules on successive ticks', async () => {
    const poisoned = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    const { runId: healthy } = await startedListRun();
    await database.query(`UPDATE agent_schedules SET next_run_at=now()-interval '1 minute'
      WHERE workflow_run->>'timer'='deadline'`);
    await database.query(`INSERT INTO agent_schedules
      (id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at)
      VALUES($1,$2,$3,$4,$5,'{"kind":"interval","everyMinutes":1}','ordinary tick',now()-interval '1 minute')`,
      [randomUUID(), WORKSPACE, ROOM, WORKER_A, OWNER]);
    const poisonId = (await database.query<{ id: string }>(`SELECT id FROM agent_schedules
      WHERE workflow_run->>'runId'=$1 AND workflow_run->>'timer'='deadline'`, [poisoned])).rows[0]!.id;
    await database.query(`UPDATE agent_schedules SET next_run_at=now()-interval '2 minutes' WHERE id=$1`, [poisonId]);
    let throws = 0;
    const wrap = (inner: SqlDatabase): SqlDatabase => ({
      async query(sql, values) {
        const result = await inner.query(sql, values);
        if (sql === 'DELETE FROM agent_schedules WHERE id=$1 RETURNING id' && values?.[0] === poisonId) {
          throws++;
          throw new Error('injected timer failure after claim');
        }
        return result as any;
      },
      transaction: (work) => inner.transaction((tx) => work(wrap(tx))),
    });
    const loop = new AgentScheduleLoop(wrap(database));
    const now = new Date();
    expect(await loop.runOnce(now)).toBe(2);
    expect((await getWorkflowRun(database, ROOM, healthy)).status).toBe('failed');
    expect(throws).toBe(1);
    expect(await loop.runOnce(now)).toBe(0);
    expect(throws).toBe(1);
    expect(await loop.runOnce(new Date(now.getTime() + 61_000))).toBe(1);
    expect(throws).toBe(2);
    expect((await database.query(`SELECT id FROM messages WHERE text='ordinary tick'`)).rowCount).toBe(2);
    console.log('Demonstrated workflow-stalls-1: poisoned timer backed off; healthy deadline and ordinary schedules fired across ticks');
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
    const { runId } = await startedListRun();
    const command = (await database.query<CommandRow>(`SELECT * FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2`, [runId, WORKER_A])).rows[0]!;
    const generationId = 'workflow-stalls-3';
    await claimAgentCommand(database, ROOM, WORKER_A, command.id, generationId);
    await database.query(`DELETE FROM workspace_skills WHERE slug='list-flow'`);
    const daemon = new DaemonService(database, new LiveHub());
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

  it('re-arms an exhausted role list and retries from its start when an agent recovers', async () => {
    const { runId } = await startedListRun();
    await withoutTimeouts('list-flow', 'work');
    await reassignFailedWorkflowRole(database, { roomId: ROOM, requestId: runId, agentId: WORKER_A });
    await reportPresence(WORKER_A, 'offline');
    await reportPresence(WORKER_B, 'offline');
    expect(await fireTimer(runId, 'step')).toBe(1);
    const timer = (await database.query<{ next_run_at: Date }>(`SELECT next_run_at FROM agent_schedules
      WHERE workflow_run->>'runId'=$1 AND workflow_run->>'timer'='step'`, [runId])).rows[0];
    expect(timer).toBeDefined();
    expect(timer!.next_run_at.getTime()).toBeGreaterThan(Date.now() + 3_500_000);
    expect(await new AgentScheduleLoop(database).runOnce()).toBe(0);
    await reportPresence(WORKER_A, 'online');
    expect(await fireTimer(runId, 'step')).toBe(1);
    expect(await listRunCard(runId)).toMatchObject({ seq: 2, roleBindings: { worker: WORKER_A } });
    console.log('Demonstrated workflow-stalls-5: exhausted list re-armed at its normal interval and reassigned recovered first agent');
  });
});

describe('workflow cleanup migration', () => {
  it('Reproduction cleanup-transaction: a SQL recovery error leaves other runs and the startup marker intact', async () => {
    const failed = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    const { runId: healthy } = await startedListRun();
    await database.query(`DELETE FROM workflow_backfills WHERE name='workflow-storage-v1'`);
    await database.query(`DELETE FROM agent_schedules WHERE workflow_run->>'runId'=ANY($1::text[])`, [[failed, healthy]]);
    await database.query(`CREATE FUNCTION reject_gated_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.workflow_run->>'workflowSlug' = 'gated' THEN
          RAISE EXCEPTION 'broken run recovery' USING ERRCODE = '22000';
        END IF;
        RETURN NEW;
      END $$`);
    await database.query(`CREATE TRIGGER reject_gated_recovery BEFORE INSERT ON agent_schedules
      FOR EACH ROW EXECUTE FUNCTION reject_gated_recovery()`);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await migrateData(database);
      expect(errors).toHaveBeenCalledWith(
        `backfillWorkflowRunTimers: failed to recover run ${failed}`,
        expect.objectContaining({ code: '22000' }),
      );
      expect((await database.query(`SELECT workflow_run->>'timer' timer FROM agent_schedules
        WHERE workflow_run->>'runId'=$1 ORDER BY timer`, [healthy])).rows)
        .toEqual([{ timer: 'deadline' }, { timer: 'step' }]);
      expect((await database.query(`SELECT id FROM agent_schedules WHERE workflow_run->>'runId'=$1`, [failed])).rows).toEqual([]);
      expect((await database.query(`SELECT name FROM workflow_backfills WHERE name='workflow-storage-v1'`)).rows)
        .toEqual([{ name: 'workflow-storage-v1' }]);
      const failures = errors.mock.calls.length;
      await migrateData(database);
      // Timer recovery runs every boot, so only the broken run is retried.
      expect(errors.mock.calls.slice(failures)).toEqual([
        [`backfillWorkflowRunTimers: failed to recover run ${failed}`, expect.objectContaining({ code: '22000' })],
      ]);
      expect((await database.query(`SELECT workflow_run->>'timer' timer FROM agent_schedules
        WHERE workflow_run->>'runId'=$1 ORDER BY timer`, [healthy])).rows)
        .toEqual([{ timer: 'deadline' }, { timer: 'step' }]);
      console.log('Demonstrated cleanup-transaction: startup isolated a real SQL error, recovered the healthy run, and persisted its completion marker');
    } finally {
      errors.mockRestore();
    }
  });

  it('Demonstrated cleanup-storage: migrates every legacy shape once and a person can still answer the live gate', async () => {
    const ended = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    await reachGate(ended);
    await answerGate(ended, 'publish');
    const live = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    await reachGate(live);
    await database.query(`DELETE FROM workflow_backfills WHERE name='workflow-storage-v1'`);
    await database.query(`UPDATE messages SET card=card-'runStatus' || '{"active":true}'::jsonb WHERE id=ANY($1::text[])`, [[ended, live]]);
    await database.query(`UPDATE messages SET card=card-'seq' WHERE card_type='workflow-handoff' AND card->>'runId'=$1`, [live]);
    // This fixture predates readable gate prompts as well as attempt metadata.
    await database.query(`UPDATE room_choices SET prompt='gated: sign_off'
      WHERE message_id IN (SELECT id FROM messages WHERE card->>'runId'=$1)`, [live]);
    await database.query(`UPDATE messages SET card=card-'attempt' WHERE id IN (SELECT message_id FROM room_choices) AND card->>'runId'=$1`, [live]);
    const oldId = randomUUID();
    await database.query(`UPDATE agent_schedules SET id=$2,workflow_run=workflow_run-'timer'-'attempt'
      WHERE workflow_run->>'runId'=$1 AND workflow_run->>'timer'='step'`, [live, oldId]);
    const due = (await database.query(`SELECT next_run_at FROM agent_schedules WHERE id=$1`, [oldId])).rows[0]!;
    const commandsBefore = (await database.query(`SELECT * FROM agent_commands ORDER BY id`)).rows;
    await migrateData(database);
    expect((await database.query(`SELECT id,card->>'runStatus' run_status,card ? 'active' active FROM messages WHERE id=ANY($1::text[]) ORDER BY id`, [[ended, live]])).rows)
      .toEqual([{ id: ended, run_status: 'done', active: false }, { id: live, run_status: 'live', active: false }].sort((a,b) => a.id.localeCompare(b.id)));
    expect((await database.query(`SELECT card->>'seq' seq FROM messages WHERE card_type='workflow-handoff' AND card->>'runId'=$1 ORDER BY (card->>'seq')::int`, [live])).rows)
      .toEqual([{ seq: '-1' }, { seq: '0' }]);
    const timer = (await database.query<{ id: string; next_run_at: Date; workflow_run: unknown }>(`SELECT id,next_run_at,workflow_run FROM agent_schedules
      WHERE workflow_run->>'runId'=$1 AND workflow_run->>'timer'='step'`, [live])).rows[0]!;
    expect(timer.id).not.toBe(oldId);
    expect(timer.next_run_at).toEqual(due.next_run_at);
    expect(timer.workflow_run).toMatchObject({ timer: 'step', attempt: 0 });
    expect((await database.query(`SELECT * FROM agent_commands ORDER BY id`)).rows).toEqual(commandsBefore);
    expect(await getWorkflowRun(database, ROOM, live)).toMatchObject({ state: 'sign_off', status: 'live', attempt: 0 });
    const snapshot = async () => ({
      messages: (await database.query(`SELECT id,card FROM messages WHERE card->>'runId'=ANY($1::text[]) ORDER BY id`, [[ended, live]])).rows,
      timers: (await database.query(`SELECT * FROM agent_schedules ORDER BY id`)).rows,
    });
    const once = await snapshot();
    await normalizeLegacyWorkflowRuns(database);
    expect(await snapshot()).toEqual(once);
    const recorded = new RecordingDatabase(database);
    await migrateData(recorded);
    expect(await snapshot()).toEqual(once);
    expect(recorded.calls.some(({ sql }) => sql.includes('WITH missing AS') || sql.includes('FROM room_choices choice JOIN messages choicemsg'))).toBe(false);
    await answerGate(live, 'publish');
    expect(await getWorkflowRun(database, ROOM, live)).toMatchObject({ status: 'done' });
    console.log('Demonstrated cleanup-storage: legacy live gate kept its lease and received no new wake; second startup skipped backfills; human answer completed the run');
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
    await database.query(`UPDATE messages SET card=card-'runStatus' || '{"active":true}'::jsonb WHERE id=ANY($1::text[])`, [[runs.done, runs.deadline, live]]);
    await database.query(`UPDATE messages SET card=card || '{"active":true}'::jsonb WHERE id=$1`, [runs.failed]);
    await database.query(`UPDATE messages SET card=card-'runStatus' WHERE id=$1`, [runs.cancelled]);
    expect(await saveUnsavedWorkflowRunStatus(database)).toBe(5);
    expect(await saveUnsavedWorkflowRunStatus(database)).toBe(0);
    await expectStatus(runs.done, 'done');
    await expectStatus(runs.failed, 'failed');
    await expectStatus(runs.deadline, 'failed');
    await expectStatus(runs.cancelled, 'abandoned');
    await expectStatus(live, 'live');
    expect((await database.query(`SELECT 1 FROM messages WHERE id=ANY($1::text[]) AND card ? 'active'`, [all])).rowCount).toBe(0);
  });

  it('re-arms a live run timer lost after deploy on every boot, exactly once', async () => {
    const runId = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    const timers = async () => (await database.query<{ id: string; timer: string }>(
      `SELECT id,workflow_run->>'timer' timer FROM agent_schedules WHERE workflow_run->>'runId'=$1 ORDER BY timer`, [runId],
    )).rows;
    const armed = await timers();
    await migrateData(database);
    await database.query(`DELETE FROM agent_schedules WHERE workflow_run->>'runId'=$1 AND workflow_run->>'timer'='step'`, [runId]);
    await migrateData(database);
    await migrateData(database);
    expect(await timers()).toEqual(armed);
    console.log('Demonstrated run-timers: a step timer deleted after the one-time backfills ran was re-armed once by the next boot');
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
