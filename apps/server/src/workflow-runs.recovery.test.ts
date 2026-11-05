import { HelperDaemonService, normalizeLegacyWorkflowRuns, saveUnsavedWorkflowRunStatus, readWorkflowRun, LiveHub, describedWorkflow, SYSTEM_IDENTITY_ID, createHash, randomUUID, describe, expect, it, vi, migrate, migrateData, claimAgentCommand, createAgentCommand, readAgentCommands, postRoomChoice, AgentScheduleLoop, PhoneService, FEEDBACK_TRIAGE_CONTRACT, backfillWorkflowRunTimers, backfillWorkflowSkillDescriptions, describedLegacyWorkflowContract, handoff, getWorkflowRun, cancelWorkflowRun, saveWorkflow, settleWorkflowGate, startWorkflow, WORKFLOW_LEGACY_STEP_TIMEOUT_SECONDS, APPROVER, CONTRACT, GATED, IMPLEMENTER, LIST_CONTRACT, OUTSIDER, OWNER, REVIEWER, ROOM, RecordingDatabase, WORKER_A, WORKER_B, WORKSPACE, addAgent, adminCommand, answerGate, commandFor, database, driveToApprovalGate, fireTimer, listRunCard, ownerNotices, pendingCommandsFor, reachGate, reportPresence, rootMessage, runCards, startedGatedRun, startedListRun, startedRun, withoutTimeouts, fixtureScope1, fixtureScope7, type SqlDatabase, type CommandRow } from './workflow-runs.recovery.test-support.js';

describe('backfillWorkflowSkillDescriptions', () => {
const scope1 = fixtureScope1();


  it('derives each custom step from its own instruction or fields and is idempotent', async () => {
    const markdown = JSON.stringify(CONTRACT);
    const skillId = await scope1.seedLegacySkillVersion('legacy-corner', markdown);

    await expect(backfillWorkflowSkillDescriptions(database)).resolves.toBe(1);

    const described = JSON.parse(await scope1.markdownFor(skillId));
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
    expect(await scope1.markdownFor(skillId)).toBe(JSON.stringify(described));
  });


  it('writes a usable summary when the description is empty', async () => {
    const blank = { ...CONTRACT, description: '   ' };
    const skillId = await scope1.seedLegacySkillVersion('legacy-blank', JSON.stringify(blank));
    await expect(backfillWorkflowSkillDescriptions(database)).resolves.toBe(1);
    expect(JSON.parse(await scope1.markdownFor(skillId)).summary).toBe('Run the corner workflow.');
  });


  it('repairs every saved seeded version with authored copy and serves the repaired current version', async () => {
    const stale = JSON.parse(JSON.stringify(FEEDBACK_TRIAGE_CONTRACT));
    stale.summary = 'Summary not written yet';
    for (const [name, step] of Object.entries(stale.handoffs))
      step.does = `Step ${name}: describe what this step does`;
    const skillId = await scope1.seedLegacySkillVersion('feedback-triage', JSON.stringify(stale), 'feedback-triage-v1');
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
    const skillId = await scope1.seedLegacySkillVersion('custom-hint', JSON.stringify(legacy));
    await backfillWorkflowSkillDescriptions(database);
    expect(JSON.parse(await scope1.markdownFor(skillId)).handoffs.implement.does)
      .toBe('Draft the change and open a pull request.');
  });


  it('leaves an already-described contract untouched, including its content hash', async () => {
    const markdown = JSON.stringify(describedWorkflow(CONTRACT), null, 2);
    const skillId = await scope1.seedLegacySkillVersion('already-described', markdown);
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
    const delay = await loop.nextDelayMs();
    expect(delay).toBeGreaterThan(3_500_000);
    expect(await new AgentScheduleLoop(database).runOnce(new Date(Date.now() + 3_700_000))).toBe(1);
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
const scope7 = fixtureScope7();


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
    await scope7.removeStepTimeout('list-flow', 'work');
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
      const timers = await scope7.timersFor(runId);
      expect(timers.map((row) => row.workflow_run.timer)).toEqual(['deadline', 'step']);
      expect(await scope7.timersFor(orphaned)).toEqual([]);
      await expect(migrateData(database)).resolves.toBeUndefined();
      expect(await scope7.timersFor(runId)).toEqual(timers);
      expect(await scope7.timersFor(orphaned)).toEqual([]);
      console.log('Demonstrated orphaned-run: boot migration completed despite a missing contract; the healthy legacy run received deadline and step timers, unchanged on repeat boot');
    } finally {
      errors.mockRestore();
    }
  });


  it('gives a legacy current attempt a full lease, fails over, and takes its declared timeout after exhaustion', async () => {
    const { runId } = await startedListRun();
    await scope7.removeStepTimeout('list-flow', 'work');
    await database.query(`DELETE FROM agent_schedules WHERE workflow_run->>'runId'=$1`, [runId]);
    await database.query(
      `UPDATE messages SET card=card-'seq'-'deadlineSeconds'-'runStatus',created_at=now()-interval '2 hours' WHERE id=$1`, [runId],
    );
    await normalizeLegacyWorkflowRuns(database);
    expect(await saveUnsavedWorkflowRunStatus(database)).toBe(1);
    const before = Date.now();
    expect(await backfillWorkflowRunTimers(database)).toBe(2);
    const timers = await scope7.timersFor(runId);
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
    expect(await scope7.timersFor(runId)).toEqual(timers);

    expect(await fireTimer(runId, 'step')).toBe(1);
    expect(await listRunCard(runId)).toMatchObject({ seq: 1, roleBindings: { worker: WORKER_B } });
    const next = await scope7.timersFor(runId);
    expect(next[1]!.workflow_run.attempt).toBe(1);
    expect(next[1]!.next_run_at.getTime()).toBeGreaterThan(Date.now() + 3_500_000);
    expect(await fireTimer(runId, 'step')).toBe(1);
    const ended = await getWorkflowRun(database, ROOM, runId);
    expect(ended).toMatchObject({ state: 'failed', status: 'failed' });
    expect(ended.history.at(-1)).toMatchObject({ outcome: 'timeout' });
    expect(await backfillWorkflowRunTimers(database)).toBe(0);
    expect(await scope7.timersFor(runId)).toEqual([]);
  });


  it('arms the default for newly dispatched legacy steps and retries a step without a timeout outcome', async () => {
    await saveWorkflow(database, await commandFor(WORKER_A), { contract: describedWorkflow(LIST_CONTRACT) });
    await withoutTimeouts('list-flow', 'work');
    const { runId } = await startWorkflow(database, await commandFor(WORKER_A), {
      name: 'list-flow', roleBindings: { worker: WORKER_A, closer: APPROVER },
    });
    const timers = await scope7.timersFor(runId);
    expect(timers[1]!.workflow_run).toMatchObject({ timer: 'step', attempt: 0 });
    expect(timers[1]!.next_run_at.getTime()).toBeGreaterThan(Date.now() + 3_500_000);
    expect(await fireTimer(runId, 'step')).toBe(1);
    expect((await getWorkflowRun(database, ROOM, runId)).status).toBe('live');
    expect((await scope7.timersFor(runId)).map((row) => row.workflow_run.timer)).toEqual(['deadline', 'step']);
    expect(await fireTimer(runId, 'deadline')).toBe(1);
    expect((await getWorkflowRun(database, ROOM, runId)).status).toBe('failed');
  });


  it('uses the pinned deadline, preserves existing declared timers, and takes the run lock before reading its head', async () => {
    const runId = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    await reachGate(runId);
    const gateTimer = (await scope7.timersFor(runId))[1]!;
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
    const timers = await scope7.timersFor(runId);
    const start = (await database.query<{ created_at: Date }>(`SELECT created_at FROM messages WHERE id=$1`, [runId])).rows[0]!;
    expect(timers[0]!.next_run_at.getTime()).toBe(start.created_at.getTime() + 7_200_000);
    expect(timers[1]).toEqual(gateTimer);
    expect(await backfillWorkflowRunTimers(database)).toBe(0);
    expect(await scope7.timersFor(runId)).toEqual(timers);
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
    expect(await scope7.timersFor(ended)).toEqual([]);
    expect(await scope7.timersFor(cancelled)).toEqual([]);
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
        if (/^DELETE FROM agent_schedules schedule\s+WHERE schedule.id=\$1/.test(sql) && values?.[0] === poisonId) {
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
    expect(throws).toBe(1);
    expect((await database.query(`SELECT failed_due_at=next_run_at AND failed_revision=updated_at parked
      FROM agent_schedules WHERE id=$1`,[poisonId])).rows).toEqual([{parked:true}]);
    expect((await database.query(`SELECT id FROM messages WHERE text='ordinary tick'`)).rowCount).toBe(2);
    console.log('Demonstrated workflow-stalls-1: poisoned occurrence stays parked; healthy deadlines and ordinary schedules fire');
  });
});
