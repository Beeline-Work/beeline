import { ExpectedRefusalError } from './command-refusal.js';
import { activeWorkflowRunIds } from './workflow-admin.js';
import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { describedWorkflow, insertCornerFacts } from "../../../tests/helpers/server.js";
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { claimAgentCommand, createAgentCommand, readAgentCommands, type CommandRow } from './agent-command.js';
import { answerRoomChoice } from './room-choice.js';
import { AgentScheduleLoop } from './agent-schedules.js';
import { PhoneService } from './phone-service.js';
import { SCHEDULE_SCHEDULER_ID } from '@beeline/api-contract/scheduled-prompts';
import { archiveWorkflow, assignWorkflowRole, handoff, getWorkflowRun, cancelWorkflowRun, reassignFailedWorkflowRole, saveWorkflow, startWorkflow } from './workflow-runs.js';
import { APPROVER, CONTRACT, GATED, IMPLEMENTER, LIST_CONTRACT, OUTSIDER, OWNER, REVIEWER, ROOM, WORKER_A, WORKER_B, WORKSPACE, adminCommand, answerGate, commandFor, createSchedule, database, fireTimer, listRunCard, ownerNotices, pendingCommandsFor, reachGate, reportPresence, rootMessage, runCards, scheduleOccurrence, startedGatedRun, startedListRun, startedRun } from './test-fixtures/workflow-runs.js';

vi.mock('node:crypto', async (importOriginal) => {
  const crypto = await importOriginal<typeof import('node:crypto')>();
  return { ...crypto, randomBytes: vi.fn(crypto.randomBytes) };
});

describe('list roles', () => {
  it('gives a list role to the first agent on the list and records the list on the start card', async () => {
    const { runId, state } = await startedListRun();
    expect(state).toBe('work');
    const card = await listRunCard(runId);
    expect(card.roleBindings).toEqual({ worker: WORKER_A, closer: APPROVER });
    expect(card.roleAgents).toEqual({ worker: [WORKER_A, WORKER_B] });
    expect(await pendingCommandsFor(WORKER_A)).toBeGreaterThan(0);
    expect(await pendingCommandsFor(WORKER_B)).toBe(0);
  });

  it('skips an unhealthy agent at the head of the list', async () => {
    await reportPresence(WORKER_A, 'offline');
    const { runId } = await startedListRun();
    expect((await listRunCard(runId)).roleBindings.worker).toBe(WORKER_B);
    expect(await pendingCommandsFor(WORKER_A)).toBe(0);
  });

  it('rejects a class word, a duplicate, an empty list, and a non-member on the list', async () => {
    const command = await commandFor(IMPLEMENTER);
    await saveWorkflow(database, command, { contract: describedWorkflow(LIST_CONTRACT)});
    const start = (worker: unknown) =>
      startWorkflow(database, command, {
        name: 'list-flow',
        roleBindings: { worker: worker as string[], closer: APPROVER },
      });
    await expect(start('heavy')).rejects.toThrow('must be an agent id or a member handle');
    await expect(start([WORKER_A, WORKER_A])).rejects.toThrow('must be an agent id or a member handle');
    await expect(start([])).rejects.toThrow('must be an agent id or a member handle');
    await expect(start([WORKER_A, 'f'.repeat(64)])).rejects.toThrow('current agent member');
  });

  it('rejects a human Room member as a binding, alone or on a list, before any card is written', async () => {
    await database.query(`UPDATE identities SET handle='owner' WHERE id=$1`, [OWNER]);
    const command = await commandFor(IMPLEMENTER);
    await saveWorkflow(database, command, { contract: describedWorkflow(LIST_CONTRACT)});
    const start = (worker: unknown) =>
      startWorkflow(database, command, {
        name: 'list-flow',
        roleBindings: { worker: worker as string[], closer: APPROVER },
      });
    await expect(start(OWNER)).rejects.toThrow('current agent member');
    await expect(start('owner')).rejects.toThrow('current agent member');
    await expect(start('@owner')).rejects.toThrow('current agent member');
    await expect(start([WORKER_A, '@owner'])).rejects.toThrow('current agent member');
    const cards = await database.query(
      `SELECT 1 FROM messages WHERE room_id=$1 AND card_type='workflow-handoff'`,
      [ROOM],
    );
    expect(cards.rowCount).toBe(0);
  });

  it('rejects a bare human handle in the member-handle path, before any card is written', async () => {
    await database.query(`UPDATE identities SET handle='owner' WHERE id=$1`, [OWNER]);
    await expect(startedListRun('owner')).rejects.toThrow('current agent member');
    const cards = await database.query(
      `SELECT 1 FROM messages WHERE room_id=$1 AND card_type='workflow-handoff'`,
      [ROOM],
    );
    expect(cards.rowCount).toBe(0);
  });

  it('resolves @handles on a list to the Room members with those handles', async () => {
    await database.query(`UPDATE identities SET handle='wb' WHERE id=$1`, [WORKER_B]);
    await reportPresence(WORKER_A, 'offline');
    const { runId } = await startedListRun([WORKER_A, '@wb']);
    const card = await listRunCard(runId);
    expect(card.roleAgents).toEqual({ worker: [WORKER_A, WORKER_B] });
    expect(card.roleBindings.worker).toBe(WORKER_B);
  });

  it('treats a one-agent list as a single-agent role', async () => {
    const { runId } = await startedListRun([WORKER_B]);
    const card = await listRunCard(runId);
    expect(card.roleBindings.worker).toBe(WORKER_B);
    expect(card.roleAgents).toBeUndefined();
  });

  it('is sticky: a loop back to the same role reuses the resolved agent', async () => {
    const { runId } = await startedListRun();
    const command = await commandFor(WORKER_A);
    const looped = await handoff(database, command, {
      runId,
      outcome: 'retry',
      contents: { note: 'not done yet' },
    });
    expect(looped.state).toBe('work');
    expect((await listRunCard(runId)).roleBindings.worker).toBe(WORKER_A);
  });

  it('fails over to the next healthy agent on the list on an instant failure of the current holder', async () => {
    const { runId } = await startedListRun();
    await reassignFailedWorkflowRole(database, { roomId: ROOM, requestId: runId, agentId: WORKER_A });
    const reassigned = await listRunCard(runId);
    expect(reassigned.reassigned).toBe(true);
    expect(reassigned.toState).toBe('work');
    expect(reassigned.roleBindings.worker).toBe(WORKER_B);
    expect(await pendingCommandsFor(WORKER_B)).toBeGreaterThan(0);
    // A late response from the failed-over agent no longer owns the state.
    const staleCommand = await commandFor(WORKER_A);
    await expect(
      handoff(database, staleCommand, { runId, outcome: 'done', contents: { note: 'too late' } }),
    ).rejects.toThrow('not you');
  });

  it('fails over down the list only, never back to an earlier agent that recovered', async () => {
    await database.query(`INSERT INTO agents(agent_id,owner_id,selected_model) VALUES($1,$2,'opus-4-5')`, [
      REVIEWER,
      OWNER,
    ]);
    await reportPresence(WORKER_A, 'offline');
    await reportPresence(REVIEWER, 'online');
    const { runId } = await startedListRun([WORKER_A, WORKER_B, REVIEWER]);
    expect((await listRunCard(runId)).roleBindings.worker).toBe(WORKER_B);
    await reportPresence(WORKER_A, 'online');
    await reassignFailedWorkflowRole(database, { roomId: ROOM, requestId: runId, agentId: WORKER_B });
    expect((await listRunCard(runId)).roleBindings.worker).toBe(REVIEWER);
    expect(await pendingCommandsFor(WORKER_A)).toBe(0);
  });

  it('moves an expired step to the next agent on the list even if the current agent never answers', async () => {
    const { runId } = await startedListRun();
    const oldWake = (await readAgentCommands(database, ROOM, WORKER_A)).commands[0]!;
    // The step timer belongs to the run and names the attempt it times.
    const schedule = await database.query<{ agent_id: string; attempt: string }>(
      `SELECT agent_id,workflow_run->>'attempt' attempt FROM agent_schedules WHERE room_id=$1 AND workflow_run->>'timer'='step'`,
      [ROOM],
    );
    expect(schedule.rows).toEqual([{ agent_id: SYSTEM_IDENTITY_ID, attempt: '0' }]);
    await database.query(
      `UPDATE agent_schedules SET next_run_at=now()-interval '1 minute' WHERE room_id=$1 AND workflow_run->>'timer'='step'`,
      [ROOM],
    );
    expect(await new AgentScheduleLoop(database).runOnce()).toBe(1);
    const card = await listRunCard(runId) as Awaited<ReturnType<typeof listRunCard>> & { tried?: unknown };
    expect(card).toMatchObject({ seq: 1, reassigned: true, roleBindings: { worker: WORKER_B } });
    expect(card.tried).toEqual([{ agentId: WORKER_A, reason: 'its lease expired' }]);
    expect(await pendingCommandsFor(WORKER_B)).toBe(1);
    // The silent agent's pending dispatch is cancelled: it cannot act on the old attempt.
    expect(await pendingCommandsFor(WORKER_A)).toBe(0);
    await expect(database.transaction(db => claimAgentCommand(db, ROOM, WORKER_A, oldWake.id, 'late-helper')))
      .rejects.toThrow('command claim conflict');
  });

  it('refuses a workflow wake as soon as its timer is due, before the timer loop runs', async () => {
    await startedListRun();
    const wake = (await readAgentCommands(database, ROOM, WORKER_A)).commands[0]!;
    await database.query(`UPDATE agent_schedules SET next_run_at=now()-interval '1 minute'
      WHERE room_id=$1 AND workflow_run->>'timer'='step'`, [ROOM]);
    await expect(database.transaction(db => claimAgentCommand(db, ROOM, WORKER_A, wake.id, 'late-helper')))
      .rejects.toThrow('command claim conflict');
    expect((await readAgentCommands(database, ROOM, WORKER_A)).commands).toHaveLength(0);
    expect((await database.query(`SELECT cancellation_reason FROM agent_commands WHERE id=$1`, [wake.id])).rows[0])
      .toEqual({ cancellation_reason: 'workflow_attempt_expired' });
  });

  it('does not revive an older request when the newest return wake has timed out', async () => {
    const source = randomBytes(32).toString('hex');
    await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'An old request')`,
      [source, ROOM, OWNER]);
    const old = (await createAgentCommand(database, {
      roomId: ROOM, agentId: WORKER_A, sourceMessageId: source, reason: 'human_tag',
    }))!;
    await database.query(`UPDATE agent_commands SET created_at=now()-interval '2 minutes' WHERE id=$1`, [old.id]);
    await startedListRun();
    await database.query(`UPDATE agent_schedules SET next_run_at=now()-interval '1 minute'
      WHERE room_id=$1 AND workflow_run->>'timer'='step'`, [ROOM]);
    expect((await readAgentCommands(database, ROOM, WORKER_A)).commands).toHaveLength(0);
    await expect(database.transaction(db => claimAgentCommand(db, ROOM, WORKER_A, old.id, 'late-helper')))
      .rejects.toThrow('command claim conflict');
  });

  it('cancels an expired claimed workflow wake when the step fails over', async () => {
    await startedListRun();
    const wake = (await readAgentCommands(database, ROOM, WORKER_A)).commands[0]!;
    await claimAgentCommand(database, ROOM, WORKER_A, wake.id, 'gone-helper');
    await database.query(`UPDATE agent_commands SET lease_expires_at=now()-interval '1 minute' WHERE id=$1`, [wake.id]);
    await database.query(`UPDATE agent_schedules SET next_run_at=now()-interval '1 minute'
      WHERE room_id=$1 AND workflow_run->>'timer'='step'`, [ROOM]);
    await new AgentScheduleLoop(database).runOnce();
    expect((await readAgentCommands(database, ROOM, WORKER_A)).commands).toHaveLength(0);
    await expect(database.transaction(db => claimAgentCommand(db, ROOM, WORKER_A, wake.id, 'late-helper')))
      .rejects.toThrow('command claim conflict');
    const daemon = new DaemonService(database, new LiveHub());
    await expect(daemon.execute('postRoomMessage', {
      roomId: ROOM, requestId: wake.turnRequestId, generationId: 'gone-helper', text: 'Too late',
    }, WORKER_A)).rejects.toThrow();
  });

  it('asks a human when nobody on the list is healthy, leaving the run parked with no agent dispatched', async () => {
    await reportPresence(WORKER_A, 'offline');
    await reportPresence(WORKER_B, 'offline');
    const { runId } = await startedListRun();
    expect(await pendingCommandsFor(WORKER_A)).toBe(0);
    expect(await pendingCommandsFor(WORKER_B)).toBe(0);
    expect((await listRunCard(runId)).roleBindings.worker).toBeUndefined();
    const notice = await database.query<{ text: string }>(
      `SELECT text FROM messages WHERE room_id=$1 AND text LIKE '%worker role''s list%'`,
      [ROOM],
    );
    expect(notice.rows).toHaveLength(1);
    expect(notice.rows[0]!.text).not.toMatch(/class|tag|tier/i);
  });

  it('assign_workflow_role binds any agent in the Room to a parked list role, on the list or not', async () => {
    await reportPresence(WORKER_A, 'offline');
    await reportPresence(WORKER_B, 'offline');
    const { runId } = await startedListRun();
    const command = await commandFor(IMPLEMENTER);
    const result = await assignWorkflowRole(database, command, {
      runId,
      role: 'worker',
      targetAgentId: REVIEWER,
    });
    expect(result.state).toBe('work');
    expect((await listRunCard(runId)).roleBindings.worker).toBe(REVIEWER);
    expect(await pendingCommandsFor(REVIEWER)).toBeGreaterThan(0);
  });

  it.each([OWNER, OUTSIDER])('rejects assign_workflow_role targeting human/nonmember %s as an expected refusal', async (targetAgentId) => {
    if (targetAgentId === OUTSIDER) {
      await database.query(`UPDATE identities SET kind='agent' WHERE id=$1`, [OUTSIDER]);
    }
    await reportPresence(WORKER_A, 'offline');
    await reportPresence(WORKER_B, 'offline');
    const { runId } = await startedListRun();
    const command = await commandFor(IMPLEMENTER);
    const refusal = assignWorkflowRole(database, command, { runId, role: 'worker', targetAgentId });
    await expect(refusal).rejects.toThrow(`${targetAgentId} is not a current agent member of this Room`);
    await expect(refusal).rejects.toBeInstanceOf(ExpectedRefusalError);
    expect((await listRunCard(runId)).roleBindings.worker).toBeUndefined();
  });

  it('assign_workflow_role binds the Room member a handle from the member list names', async () => {
    await database.query(`UPDATE identities SET handle='rev' WHERE id=$1`, [REVIEWER]);
    await reportPresence(WORKER_A, 'offline');
    await reportPresence(WORKER_B, 'offline');
    const { runId } = await startedListRun();
    const command = await commandFor(IMPLEMENTER);
    await assignWorkflowRole(database, command, { runId, role: 'worker', targetAgentId: '@rev' });
    expect((await listRunCard(runId)).roleBindings.worker).toBe(REVIEWER);
    await expect(
      assignWorkflowRole(database, command, { runId, role: 'worker', targetAgentId: 'nobody' }),
    ).rejects.toThrow('@nobody is not a current member of this Room');
  });

  it('assign_workflow_role also rebinds a role bound to one agent, not only a list role', async () => {
    const { runId } = await startedListRun();
    const advanced = await handoff(database, await commandFor(WORKER_A), {
      runId,
      outcome: 'done',
      contents: { note: 'finished' },
    });
    expect(advanced.state).toBe('close');
    const command = await commandFor(IMPLEMENTER);
    const result = await assignWorkflowRole(database, command, {
      runId,
      role: 'closer',
      targetAgentId: WORKER_A,
    });
    expect(result.state).toBe('close');
    expect((await listRunCard(runId)).roleBindings.closer).toBe(WORKER_A);
    expect(await pendingCommandsFor(WORKER_A)).toBeGreaterThan(0);
  });
});

describe('member handles as workflow role bindings', () => {
  it('binds a bare member handle, alone or on a list, to that member', async () => {
    await database.query(`UPDATE identities SET handle='candy' WHERE id=$1`, [WORKER_A]);
    await database.query(`UPDATE identities SET handle='wb' WHERE id=$1`, [WORKER_B]);
    const singleRun = (await startedListRun('candy')).runId;
    const single = await listRunCard(singleRun);
    expect(single.roleBindings.worker).toBe(WORKER_A);
    expect(single.roleAgents).toBeUndefined();
    await cancelWorkflowRun(database, await commandFor(IMPLEMENTER), { runId: singleRun, reason: 'next case' });
    const list = await listRunCard((await startedListRun(['wb', 'candy'])).runId);
    expect(list.roleAgents).toEqual({ worker: [WORKER_B, WORKER_A] });
    expect(list.roleBindings.worker).toBe(WORKER_B);
  });

  it('refuses a word that is no current member\'s handle, at start, before any card is written', async () => {
    await expect(startedListRun('nosuchmember')).rejects.toThrow('must be an agent id or a member handle');
    const cards = await database.query(
      `SELECT 1 FROM messages WHERE room_id=$1 AND card_type='workflow-handoff'`,
      [ROOM],
    );
    expect(cards.rowCount).toBe(0);
  });
});

describe('agent workflow run reads and cancellation', () => {
  it('reads the pinned contract, current holder, requirements and complete history after an edit and archive', async () => {
    const { runId } = await startedRun();
    const command = await commandFor(IMPLEMENTER);
    await saveWorkflow(database, await adminCommand(), { contract: describedWorkflow({ ...CONTRACT, description: 'New definition' })});
    await archiveWorkflow(database, await adminCommand(), { name: 'corner' });
    expect(await getWorkflowRun(database, ROOM, runId)).toMatchObject({
      runId, workflowSlug: 'corner', workflowVersion: 1, state: 'implement', status: 'live',
      role: 'implementer', boundAgentId: IMPLEMENTER, requiredFields: ['summary', 'prUrl'],
      allowedOutcomes: { pushed: 'checks', stuck: 'ask_human' }, contract: CONTRACT,
      history: [{ messageId: runId, toState: 'implement', actorId: IMPLEMENTER }],
    });
    await handoff(database, command, { runId, outcome: 'pushed', contents: { summary: 'ready', prUrl: 'test' }, receipt: { line: 'Ready for checks' } });
    const read = await getWorkflowRun(database, ROOM, runId);
    expect(read).toMatchObject({ state: 'checks', requiredFields: ['headSha'] });
    expect(read.history).toHaveLength(2);
    expect(read.history[1]).toMatchObject({ fromState: 'implement', outcome: 'pushed', receipt: { line: 'Ready for checks', exit: { actorId: IMPLEMENTER } } });
    await expect(getWorkflowRun(database, '30000000-0000-4000-8000-000000000001', runId)).rejects.toThrow('unavailable in this Room');
  });

  it('cancels the wake for an earlier attempt and states the new attempt on the next wake', async () => {
    const { runId } = await startedRun();
    await handoff(database, await commandFor(IMPLEMENTER), { runId, outcome: 'pushed', contents: { summary: 'ready', prUrl: 'test' } });
    const commands = (await readAgentCommands(database, ROOM, IMPLEMENTER)).commands;
    expect(commands.find(c => c.sourceMessageId === runId)).toBeUndefined();
    const wake = commands.find(c => c.source.body.includes(`You are in run ${runId}`));
    expect(wake?.source.body).toContain('Current state: checks');
    expect(wake?.source.body).toContain('passing -> review');
    expect(wake?.source.body).toContain('This wake is attempt 1: pass "attempt": 1 to app_tool’s beeline:workflow advance action.');
  });

  it('allows the run requester, removes pending wakes and rejects later handoffs without waking subscribers', async () => {
    const { runId } = await startedRun();
    await database.query(`UPDATE memberships SET event_subscriptions='["workflow-handoff"]'::jsonb WHERE room_id=$1`, [ROOM]);
    const command = await commandFor(IMPLEMENTER);
    const result = await cancelWorkflowRun(database, command, { runId, reason: 'Request withdrawn' });
    expect(result.status).toBe('abandoned');
    const read = await getWorkflowRun(database, ROOM, runId);
    expect(read).toMatchObject({ status: 'abandoned', allowedOutcomes: {}, requiredFields: [], cancellation: { reason: 'Request withdrawn', actorId: IMPLEMENTER } });
    expect(read.history.at(-1)?.contents).toEqual({ reason: 'Request withdrawn' });
    expect((await database.query(`SELECT 1 FROM agent_commands command JOIN messages message ON message.id=command.source_message_id WHERE command.state='pending' AND message.card->>'runId'=$1`, [runId])).rowCount).toBe(0);
    await expect(handoff(database, command, { runId, outcome: 'pushed', contents: {} })).rejects.toThrow('already ended');
    await expect(cancelWorkflowRun(database, command, { runId, reason: 'Again' })).rejects.toThrow('already ended');
  });

  it('does not redeliver an expired claim or fail over a cancelled run', async () => {
    const { runId } = await startedRun();
    await database.query(`UPDATE agent_commands SET state='claimed',lease_expires_at=now()-interval '1 minute' WHERE source_message_id=$1`, [runId]);
    await cancelWorkflowRun(database, await commandFor(IMPLEMENTER), { runId, reason: 'Stop' });
    const inbox = await readAgentCommands(database, ROOM, IMPLEMENTER);
    expect(inbox.commands.some(c => c.sourceMessageId === runId)).toBe(false);
    const count = (await getWorkflowRun(database, ROOM, runId)).history.length;
    await database.transaction(db => reassignFailedWorkflowRole(db, { roomId: ROOM, requestId: runId, agentId: IMPLEMENTER }));
    expect((await getWorkflowRun(database, ROOM, runId)).history).toHaveLength(count);
  });

  it('refuses an unrelated requester even when the executing agent holds the run', async () => {
    const { runId } = await startedRun();
    const command = await commandFor(IMPLEMENTER, await rootMessage(OUTSIDER));
    await expect(cancelWorkflowRun(database, command, { runId, reason: 'Stop' })).rejects.toMatchObject({ status: 403 });
    expect((await getWorkflowRun(database, ROOM, runId)).status).toBe('live');
  });

  it('allows the recorded human requester through another agent without admin or role ownership', async () => {
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`, [WORKSPACE, ROOM, OUTSIDER]);
    const command = await commandFor(IMPLEMENTER, await rootMessage(OUTSIDER));
    await saveWorkflow(database, command, { contract: describedWorkflow(CONTRACT)});
    const { runId } = await startWorkflow(database, command, {
      name: 'corner', roleBindings: { implementer: IMPLEMENTER, reviewer: REVIEWER, approver: APPROVER },
    });
    const delegate = await commandFor(WORKER_B, await rootMessage(OUTSIDER));
    await cancelWorkflowRun(database, delegate, { runId, reason: 'Requester withdrew' });
    expect((await getWorkflowRun(database, ROOM, runId)).cancellation?.actorId).toBe(OUTSIDER);
  });

  it('allows a bound role owner even when they did not start the run or administer the Room', async () => {
    const { runId } = await startedRun();
    await database.query(`INSERT INTO agents(agent_id,owner_id) VALUES($1,$2)`, [REVIEWER, OUTSIDER]);
    const command = await commandFor(IMPLEMENTER, await rootMessage(OUTSIDER));
    expect((await cancelWorkflowRun(database, command, { runId, reason: 'Owner withdrew' })).status).toBe('abandoned');
  });

  it('allows a human Workspace admin and records that human as the actor', async () => {
    await database.query(`UPDATE identities SET handle='owner' WHERE id=$1`, [OWNER]);
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner')`, [WORKSPACE, OWNER]);
    const { runId } = await startedRun();
    const command = await commandFor(IMPLEMENTER, await rootMessage(OWNER));
    await cancelWorkflowRun(database, command, { runId, reason: 'Admin stopped' });
    const notice = (await database.query<{ author_id: string; text: string; actor_id: string }>(
      `SELECT author_id,text,card->'cancellation'->>'actorId' actor_id FROM messages
       WHERE room_id=$1 AND card->>'runId'=$2 AND card->>'outcome'='cancelled'`,
      [ROOM, runId],
    )).rows[0]!;
    console.log('Cancellation notice:', JSON.stringify(notice));
    expect(notice.author_id).toBe(SYSTEM_IDENTITY_ID);
    expect(notice.text).toBe(`@owner cancelled workflow corner · run ${runId.slice(0, 8)}`);
    expect(notice.actor_id).toBe(OWNER);
    const room = await new PhoneService(database, 'http://localhost').readRoom(ROOM, OWNER);
    const displayedNotice = room?.messages.find(message => message.text === notice.text);
    expect(displayedNotice?.author).toMatchObject({ pubkey: SYSTEM_IDENTITY_ID, name: 'System' });
    console.log('Room cancellation notice:', JSON.stringify(displayedNotice));
    expect((await getWorkflowRun(database, ROOM, runId)).cancellation?.actorId).toBe(OWNER);
  });

  it('closes an open gate without a decision wake and removes the run from phone active reads', async () => {
    const { runId } = await startedRun(OWNER);
    const command = await commandFor(IMPLEMENTER);
    await handoff(database, command, { runId, outcome: 'stuck', contents: { summary: 'stuck', prUrl: 'none' } });
    const choice = (await database.query<{ id: string; options: { optionId: string }[] }>(`SELECT id,options FROM room_choices WHERE room_id=$1 AND status='open'`, [ROOM])).rows[0]!;
    const cancelCommand = await commandFor(IMPLEMENTER, await rootMessage(OWNER));
    await cancelWorkflowRun(database, cancelCommand, { runId, reason: 'Stop waiting' });
    expect((await database.query<{ status: string }>(`SELECT status FROM room_choices WHERE id=$1`, [choice.id])).rows[0]?.status).toBe('closed');
    await expect(answerRoomChoice(database, { choiceId: choice.id, optionId: choice.options[0]!.optionId, viewerId: OWNER })).rejects.toThrow('already decided');
    expect(await activeWorkflowRunIds(database, ROOM, 'corner', OWNER)).not.toContain(runId);
  });

  it('deletes a state timeout so the scheduler cannot wake an ended run', async () => {
    const command = await commandFor(IMPLEMENTER);
    const contract = { ...CONTRACT, handoffs: { ...CONTRACT.handoffs, implement: { ...CONTRACT.handoffs.implement, timeoutSeconds: 60, on: { ...CONTRACT.handoffs.implement.on, timeout: 'ask_human' } } } };
    await saveWorkflow(database, command, { contract: describedWorkflow(contract) });
    const { runId } = await startWorkflow(database, command, { name: 'corner', roleBindings: { implementer: IMPLEMENTER, reviewer: REVIEWER, approver: APPROVER } });
    await cancelWorkflowRun(database, command, { runId, reason: 'Stop' });
    expect((await database.query(`SELECT 1 FROM agent_schedules WHERE workflow_run->>'runId'=$1`, [runId])).rowCount).toBe(0);
    expect(await new AgentScheduleLoop(database).runOnce(new Date(Date.now() + 120000))).toBe(0);
  });
});

describe('run owner', () => {
  const SCHEDULE = '30000000-0000-4000-8000-000000000002';

  it('is the person whose message led an agent to create the schedule, never the hidden scheduler', async () => {
    await saveWorkflow(database, await commandFor(WORKER_A), { contract: describedWorkflow(GATED) });
    const parent = '20000000-0000-4000-8000-000000000099';
    await database.query(`INSERT INTO rooms(id,workspace_id,name,created_by) VALUES($1,$2,'Parent',$3)`, [parent, WORKSPACE, OWNER]);
    await database.query(`UPDATE memberships SET room_id=$1 WHERE room_id=$2`, [parent, ROOM]);
    await database.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner')`, [WORKSPACE, OWNER]);
    await database.query(`UPDATE rooms SET parent_id=$1 WHERE id=$2`, [parent, ROOM]);
    await insertCornerFacts(database, { cornerId: ROOM, ownerAgentId: WORKER_A, workerAgentId: WORKER_A });
    const asked = await rootMessage(OWNER, '@wa run gated every day');
    const creating = await commandFor(WORKER_A, asked);
    const { DaemonService } = await import('./daemon-service.js');
    void DaemonService;
    await database.query(
      `INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at,workflow_slug,owner_id)
       VALUES($1,$2,$3,$4,$4,'{"kind":"interval","everyMinutes":60}'::jsonb,'run gated',now()-interval '1 minute','gated',
         (SELECT root.author_id FROM agent_commands command JOIN messages root ON root.id=command.root_source_message_id WHERE command.id=$5))`,
      [SCHEDULE, WORKSPACE, ROOM, WORKER_A, creating.id],
    );
    expect(await new AgentScheduleLoop(database).runOnce()).toBe(1);
    const scheduled = (await database.query<CommandRow>(
      `SELECT * FROM agent_commands WHERE reason='schedule' AND agent_id=$1`, [WORKER_A],
    )).rows[0]!;
    const tick = (await database.query<{ author_id: string }>(`SELECT author_id FROM messages WHERE id=$1`, [scheduled.source_message_id])).rows[0]!;
    expect(tick.author_id).toBe(SCHEDULE_SCHEDULER_ID);
    const { runId } = await startWorkflow(database, scheduled, { name: 'gated', roleBindings: { worker: WORKER_A, approver: WORKER_A } });
    expect((await runCards(runId))[0]!.card).toMatchObject({ ownerId: OWNER, startKind: 'schedule' });
    await handoff(database, scheduled, { runId, outcome: 'done', contents: { note: 'ok' },
      attempt: (await getWorkflowRun(database, ROOM, runId)).attempt });
    await database.query(`UPDATE agent_commands SET state='complete' WHERE room_id=$1`, [ROOM]);
    const gate = (await database.query<{ id: string; card: { requester: { pubkey: string } } }>(
      `SELECT id,card FROM messages WHERE card_type='choice' AND card->>'runId'=$1`, [runId],
    )).rows[0]!;
    expect(gate.card.requester.pubkey).toBe(OWNER);
    const phone = new PhoneService(database, 'http://test');
    expect((await phone.readCorners(parent, OWNER))!.corners.find(item => item.corner.id === ROOM)?.state).toBe('waiting');
    const tray = await phone.execute('readNeedsYou', { workspaceId: WORKSPACE }, OWNER);
    expect(tray.items.some(item => item.messageId === gate.id)).toBe(true);
    console.info('Demonstrated scheduled-gate: self-created schedule → gate addressed to owner → waiting corner and Needs You card');
  });

  it('is null for an older agent-made schedule with no recorded owner, so notices go to admins', async () => {
    await database.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner')`, [WORKSPACE, OWNER]);
    await saveWorkflow(database, await commandFor(WORKER_A), { contract: describedWorkflow(GATED) });
    await database.query(
      `INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at,workflow_slug)
       VALUES($1,$2,$3,$4,$4,'{"kind":"interval","everyMinutes":60}'::jsonb,'run gated',now()-interval '1 minute','gated')`,
      [SCHEDULE, WORKSPACE, ROOM, WORKER_A],
    );
    await new AgentScheduleLoop(database).runOnce();
    const scheduled = (await database.query<CommandRow>(
      `SELECT * FROM agent_commands WHERE reason='schedule' AND agent_id=$1`, [WORKER_A],
    )).rows[0]!;
    const { runId } = await startWorkflow(database, scheduled, { name: 'gated', roleBindings: { worker: WORKER_A, approver: APPROVER } });
    expect((await runCards(runId))[0]!.card.ownerId).toBeNull();
    await reachGate(runId);
    await fireTimer(runId, 'step');
    expect(await ownerNotices(OWNER)).toHaveLength(1);
  });
});

describe('one live run per workflow per Room', () => {
  const OTHER_ROOM = '20000000-0000-4000-8000-000000000002';

  it('lets exactly one of a person\'s and an agent\'s concurrent starts succeed', async () => {
    await saveWorkflow(database, await commandFor(WORKER_A), { contract: describedWorkflow(GATED) });
    const bindings = { worker: WORKER_A, approver: APPROVER };
    const results = await Promise.allSettled([
      startWorkflow(database, { room_id: ROOM, agent_id: OWNER }, { name: 'gated', roleBindings: bindings }),
      startWorkflow(database, await commandFor(WORKER_B), { name: 'gated', roleBindings: bindings }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(String(refused.reason)).toMatch(/gated already has a live run [0-9a-f]{64} in this Room, at work/);
  });

  it('lets exactly one of a scheduled and a direct start succeed', async () => {
    await saveWorkflow(database, await commandFor(WORKER_A), { contract: describedWorkflow(GATED) });
    await createSchedule(WORKER_A, '30000000-0000-4000-8000-000000000003');
    const wake = await rootMessage(WORKER_A, 'scheduled kickoff');
    await scheduleOccurrence('30000000-0000-4000-8000-000000000003', wake);
    const bindings = { worker: WORKER_A, approver: APPROVER };
    const results = await Promise.allSettled([
      startWorkflow(database, { ...(await commandFor(WORKER_A, wake)), reason: 'schedule' }, { name: 'gated', roleBindings: bindings }),
      startWorkflow(database, await commandFor(WORKER_B), { name: 'gated', roleBindings: bindings }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  });

  it('runs the same workflow in two Rooms independently', async () => {
    await database.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Other')`, [OTHER_ROOM, WORKSPACE, OWNER]);
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner'),($1,$2,$4,'member'),($1,$2,$5,'member')`,
      [WORKSPACE, OTHER_ROOM, OWNER, WORKER_A, APPROVER],
    );
    await saveWorkflow(database, await commandFor(WORKER_A), { contract: describedWorkflow(GATED) });
    const bindings = { worker: WORKER_A, approver: APPROVER };
    await startWorkflow(database, { room_id: ROOM, agent_id: OWNER }, { name: 'gated', roleBindings: bindings });
    await expect(startWorkflow(database, { room_id: OTHER_ROOM, agent_id: OWNER }, { name: 'gated', roleBindings: bindings }))
      .resolves.toMatchObject({ state: 'work' });
  });

  it('reports a blocking run once across three slots without changing its cards or timers', async () => {
    const runId = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    await reachGate(runId);
    const scheduleId = '30000000-0000-4000-8000-000000000005';
    const now = new Date();
    await database.query(`UPDATE messages SET created_at=$2 WHERE id=$1`, [runId, new Date(now.getTime()-30*60_000)]);
    await database.query(
      `INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at,workflow_slug)
       VALUES($1,$2,$3,$4,$5,'{"kind":"interval","everyMinutes":60}'::jsonb,'run gated',$6,'gated')`,
      [scheduleId, WORKSPACE, ROOM, WORKER_B, OWNER, now],
    );
    const snapshot = async () => ({
      cards: await runCards(runId),
      timers: (await database.query(`SELECT * FROM agent_schedules WHERE workflow_run->>'runId'=$1 ORDER BY id`, [runId])).rows,
    });
    const before = await snapshot();
    const commands = await pendingCommandsFor(WORKER_B);
    for (let slot=0; slot<3; slot++) {
      await database.query(`UPDATE agent_schedules SET next_run_at=$2 WHERE id=$1`, [scheduleId, new Date(now.getTime()+slot*60_000)]);
      const tick = new Date(now.getTime()+slot*60_000);
      await Promise.all([new AgentScheduleLoop(database).runOnce(tick), new AgentScheduleLoop(database).runOnce(tick)]);
    }
    const skips = async () => (await database.query<{text:string}>(`SELECT text FROM messages WHERE room_id=$1 AND text LIKE '%skipped a run%' ORDER BY created_at,id`, [ROOM])).rows;
    expect(await snapshot()).toEqual(before);
    expect(await pendingCommandsFor(WORKER_B)).toBe(commands);
    expect(await skips()).toEqual([{text: `The gated schedule skipped a run · run ${runId} is active at step sign_off in state live for 30 min`}]);
    await cancelWorkflowRun(database, {room_id: ROOM, agent_id: OWNER} as CommandRow, {runId, reason:'next blocking run'});
    const next = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    await database.query(`UPDATE messages SET created_at=$2 WHERE id=$1`, [next, now]);
    await database.query(`UPDATE agent_schedules SET next_run_at=$2 WHERE id=$1`, [scheduleId, new Date(now.getTime()+3*60_000)]);
    await new AgentScheduleLoop(database).runOnce(new Date(now.getTime()+3*60_000));
    expect(await skips()).toHaveLength(2);
    expect((await skips())[1]!.text).toContain(`run ${next} is active at step work in state live for 3 min`);
    console.log('Reproduction blocking-run-notice: three blocked slots produced one full-ID/step/state/elapsed notice; different run produced a new notice; cards and timers unchanged');
  });

  it('posts one skip line on a schedule tick that finds a live run, and wakes no one', async () => {
    const runId = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    await database.query(
      `INSERT INTO agent_schedules(id,workspace_id,room_id,agent_id,creator_id,cadence,message,next_run_at,workflow_slug)
       VALUES($1,$2,$3,$4,$5,'{"kind":"interval","everyMinutes":60}'::jsonb,'run gated',now()-interval '1 minute','gated')`,
      ['30000000-0000-4000-8000-000000000004', WORKSPACE, ROOM, WORKER_B, OWNER],
    );
    const before = await pendingCommandsFor(WORKER_B);
    expect(await new AgentScheduleLoop(database).runOnce()).toBe(1);
    expect(await pendingCommandsFor(WORKER_B)).toBe(before);
    const skips = (await database.query<{ text: string }>(
      `SELECT text FROM messages WHERE room_id=$1 AND text LIKE '%skipped a run%'`, [ROOM],
    )).rows;
    expect(skips).toEqual([{ text: `The gated schedule skipped a run · run ${runId} is active at step work in state live for 0 min` }]);
  });
});

describe('run deadline', () => {
  it('closes the run as failed with the reason and lets the next run start', async () => {
    const runId = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    expect(await fireTimer(runId, 'deadline')).toBe(1);
    const read = await getWorkflowRun(database, ROOM, runId);
    expect(read).toMatchObject({ state: 'work', status: 'failed', allowedOutcomes: {} });
    expect(read.history.at(-1)).toMatchObject({ outcome: 'deadline', status: 'failed', contents: { reason: 'deadline' } });
    expect((await runCards(runId)).at(-1)!.text).toBe(
      `the workflow closed run ${runId.slice(0, 8)} of gated · as failed at work because it passed its deadline of 2 h`,
    );
    expect((await database.query(`SELECT 1 FROM agent_schedules WHERE workflow_run->>'runId'=$1`, [runId])).rowCount).toBe(0);
    expect((await database.query(`SELECT 1 FROM agent_commands command JOIN messages message ON message.id=command.source_message_id WHERE command.state='pending' AND message.card->>'runId'=$1`, [runId])).rowCount).toBe(0);
    await expect(startWorkflow(database, { room_id: ROOM, agent_id: OWNER }, {
      name: 'gated', roleBindings: { worker: WORKER_A, approver: APPROVER },
    })).resolves.toMatchObject({ state: 'work' });
  });

  it('fires while the run is parked at a gate and closes its card', async () => {
    const runId = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    await reachGate(runId);
    expect(await fireTimer(runId, 'deadline')).toBe(1);
    expect((await getWorkflowRun(database, ROOM, runId)).status).toBe('failed');
    const choice = (await database.query<{ status: string }>(
      `SELECT choice.status FROM room_choices choice JOIN messages message ON message.id=choice.message_id WHERE message.card->>'runId'=$1`, [runId],
    )).rows;
    expect(choice).toEqual([{ status: 'closed' }]);
  });

  it('lets exactly one of the deadline and a handoff win', async () => {
    const closed = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    await fireTimer(closed, 'deadline');
    expect(await handoff(database, await commandFor(WORKER_A), { runId: closed, outcome: 'done', contents: { note: 'late' }, attempt: 0 }))
      .toEqual({ alreadyAdvanced: true, runId: closed, state: 'work', seq: 1, status: 'failed' });

    const finished = await startedGatedRun({ room_id: ROOM, agent_id: OWNER });
    await reachGate(finished);
    await answerGate(finished, 'publish');
    expect(await fireTimer(finished, 'deadline')).toBe(0);
    expect((await getWorkflowRun(database, ROOM, finished)).status).toBe('done');
  });

  it('is not reset by reassignment, and a saved workflow gets a 24 h default', async () => {
    const { runId } = await startedListRun();
    const deadline = async () => (await database.query<{ next_run_at: Date }>(
      `SELECT next_run_at FROM agent_schedules WHERE workflow_run->>'runId'=$1 AND workflow_run->>'timer'='deadline'`, [runId],
    )).rows[0]!.next_run_at.getTime();
    const before = await deadline();
    expect(before - Date.now()).toBeGreaterThan(86_000_000);
    expect(before - Date.now()).toBeLessThanOrEqual(86_400_000);
    await reassignFailedWorkflowRole(database, { roomId: ROOM, requestId: runId, agentId: WORKER_A });
    expect(await deadline()).toBe(before);
  });
});
