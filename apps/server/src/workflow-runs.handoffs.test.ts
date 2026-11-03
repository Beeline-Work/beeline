import { readFileSync } from 'node:fs';
import { normalizeLegacyWorkflowRuns } from './migrations/workflow-cleanup.js';
import { readWorkflowRun } from './workflow-run-views.js';
import { describedWorkflow } from './test-support.js';
import { SYSTEM_IDENTITY_ID } from '@beeline/api-contract/system-identity';
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { readAgentCommands } from './agent-command.js';
import { AgentScheduleLoop } from './agent-schedules.js';
import { PhoneService } from './phone-service.js';
import { archiveWorkflow, assignWorkflowRole, closeStaleWorkflowGateChoices, handoff, getWorkflowRun, reassignFailedWorkflowRole, saveWorkflow, startWorkflow, workflowRunLockKey } from './workflow-runs.js';
import { APPROVER, CONTRACT, IMPLEMENTER, LIST_CONTRACT, OUTSIDER, OWNER, REVIEWER, ROOM, RecordingDatabase, WORKER_A, WORKER_B, WORKSPACE, adminCommand, answerGate, commandFor, database, driveToApprovalGate, listRunCard, pendingCommandsFor, reportPresence, rootMessage, startedListRun, startedRun } from './test-fixtures/workflow-runs.js';

vi.mock('node:crypto', async (importOriginal) => {
  const crypto = await importOriginal<typeof import('node:crypto')>();
  return { ...crypto, randomBytes: vi.fn(crypto.randomBytes) };
});

describe('handoff', () => {
  it('lists every missing field and outcome together, even for an invalid outcome', async () => {
    const { runId } = await startedRun();
    const command = await commandFor(IMPLEMENTER);
    for (const contents of [{}, null]) {
      await expect(handoff(database, command, { runId, outcome: 'unknown', contents }))
        .rejects.toThrow('summary is required; prUrl is required; outcome must be one of: pushed -> checks, stuck -> ask_human, timeout -> failed, or blocked with contents.reason');
    }
  });
  it('rejects a caller not bound to the current state role', async () => {
    const { runId } = await startedRun();
    const command = await commandFor(REVIEWER);
    await expect(
      handoff(database, command, { runId, outcome: 'pushed', contents: { summary: 'x', prUrl: 'y' } }),
    ).rejects.toThrow('not you');
  });

  it('rejects an unknown outcome', async () => {
    const { runId } = await startedRun();
    const command = await commandFor(IMPLEMENTER);
    await expect(
      handoff(database, command, { runId, outcome: 'nope', contents: {} }),
    ).rejects.toThrow('outcome must be one of');
  });

  it('rejects contents missing a required field', async () => {
    const { runId } = await startedRun();
    const command = await commandFor(IMPLEMENTER);
    await expect(
      handoff(database, command, { runId, outcome: 'pushed', contents: { summary: 'only this' } }),
    ).rejects.toThrow('prUrl is required');
  });

  it('advances state and wakes the next role agent', async () => {
    const { runId } = await startedRun();
    const command = await commandFor(IMPLEMENTER);
    const result = await handoff(database, command, {
      runId,
      outcome: 'pushed',
      contents: { summary: 'did the thing', prUrl: 'https://example.test/pr/1' },
    });
    expect(result.state).toBe('checks');
    expect(await pendingCommandsFor(IMPLEMENTER)).toBeGreaterThan(0);
    // The handoff card's stored text (what the mobile app renders for it,
    // same fallback as the start card) uses a short run id.
    const rows = await database.query<{ text: string; card: { runId: string } }>(
      `SELECT text,card FROM messages WHERE card_type='workflow-handoff' AND card->>'runId'=$1 ORDER BY created_at DESC LIMIT 1`,
      [runId],
    );
    expect(rows.rows[0]?.text).toBe(`Impy handed off checks · run ${runId.slice(0, 8)} of corner`);
    expect(rows.rows[0]?.card.runId).toBe(runId);
  });

  it('rejects a handoff on a run that has already ended', async () => {
    const { runId } = await startedRun(OWNER);
    let command = await commandFor(IMPLEMENTER);
    await handoff(database, command, {
      runId,
      outcome: 'pushed',
      contents: { summary: 'x', prUrl: 'y' },
    });
    command = await commandFor(IMPLEMENTER);
    await handoff(database, command, { runId, outcome: 'passing', contents: { headSha: 'abc' } });
    command = await commandFor(REVIEWER);
    await handoff(database, command, {
      runId,
      outcome: 'approved',
      contents: { verdict: 'approve', notes: 'lgtm' },
    });
    // human_approve is now open as a gate; answer it to reach the terminal land state.
    const choice = await database.query<{ id: string; options: { optionId: string; label: string }[] }>(
      `SELECT id,options FROM room_choices WHERE room_id=$1 AND agent_id=$2 AND status='open'`,
      [ROOM, APPROVER],
    );
    const gateCard = await database.query<{ card: { runId: string; workflowSlug: string } }>(
      `SELECT message.card FROM messages message JOIN room_choices choice ON choice.message_id=message.id WHERE choice.id=$1`,
      [choice.rows[0]!.id],
    );
    expect(gateCard.rows[0]?.card).toMatchObject({ runId, workflowSlug: 'corner' });
    await answerGate(runId, 'approved');
    expect(await getWorkflowRun(database, ROOM, runId)).toMatchObject({ state: 'land', status: 'done' });
    const start = await database.query<{ run_status: string }>(
      `SELECT card->>'runStatus' run_status FROM messages WHERE id=$1`, [runId],
    );
    expect(start.rows[0]?.run_status).toBe('done');
    command = await commandFor(APPROVER);
    await expect(
      handoff(database, command, { runId, outcome: 'approved', contents: { decision: 'approved' } }),
    ).rejects.toThrow('already ended');
  });

  it('caps a loop and forces onExceeded after the configured number of rounds', async () => {
    const { runId } = await startedRun();
    // The cap is 2: the loop edge may be taken twice back to `implement`, and
    // only the third attempt is forced to the loop's onExceeded target.
    const expected = ['implement', 'implement', 'ask_human'];
    for (let round = 0; round < expected.length; round += 1) {
      let command = await commandFor(IMPLEMENTER);
      await handoff(database, command, {
        runId,
        outcome: 'pushed',
        contents: { summary: 'x', prUrl: 'y' },
      });
      command = await commandFor(IMPLEMENTER);
      const checked = await handoff(database, command, {
        runId,
        outcome: 'failing',
        contents: { headSha: `sha-${round}` },
      });
      expect(checked.state).toBe(expected[round]);
    }
  });

  it.each([false, true])('demonstrates tray-choice-clarity with readable workflow choices and unchanged routing (legacy: %s)', async legacy => {
    const command = await commandFor(IMPLEMENTER, await rootMessage(OWNER));
    // Pinned runs retain their original gate even after the current seed changes.
    const legacyTriage = JSON.parse(readFileSync(new URL('../../../packages/api-contract/test-fixtures/legacy-feedback-triage.json', import.meta.url), 'utf8'));
    const contract = { ...legacyTriage, name: 'tray-proof', start: 'approve',
      handoffs: Object.fromEntries(Object.entries(legacyTriage.handoffs)
        .filter(([name]) => ['approve', 'dispatch', 'done', 'failed'].includes(name))),
    };
    await saveWorkflow(database, command, { contract });
    if (legacy) {
      const historical = { ...contract, handoffs: Object.fromEntries(Object.entries(contract.handoffs)
        .map(([name, { does: _does, ...state }]) => [name, state])) };
      await database.query(`UPDATE workspace_skill_versions SET markdown=$1
        WHERE skill_id IN (SELECT id FROM workspace_skills WHERE slug='tray-proof')`, [JSON.stringify(historical)]);
    }
    const { runId } = await startWorkflow(database, command, {
      name: 'tray-proof', roleBindings: { triager: IMPLEMENTER },
    });
    await database.query(`INSERT INTO memberships(workspace_id,identity_id,role) VALUES($1,$2,'owner')`, [WORKSPACE, OWNER]);
    const phone = new PhoneService(database, 'https://beeline.test');
    const tray = await phone.execute('readNeedsYou', { workspaceId: WORKSPACE }, OWNER) as {
      items: { messageId: string; text: string; approval?: { actions?: { kind: string; choiceId?: string; optionId?: string; label: string; detail?: string }[] } }[];
    };
    const item = tray.items.find(item => item.text === (legacy ? 'Choose the next step for tray proof' : contract.handoffs.approve!.does))!;
    expect(item).toBeDefined();
    expect(item.approval?.actions?.map(action => [action.kind, action.label, action.detail])).toEqual([
      ['choice', 'dispatch', legacy ? 'Continue to dispatch' : 'Open a fix corner for each approved problem.'],
      ['choice', 'skip', legacy ? 'Continue to done' : 'The sweep finished.'],
    ]);
    const skip = item.approval!.actions![1]!;
    await phone.execute('answerChoice', { choiceId: skip.choiceId, optionId: skip.optionId }, OWNER);
    expect((await getWorkflowRun(database, ROOM, runId)).state).toBe('done');
    console.log('Demonstrated tray-choice-clarity: readable gate → two explicit choices → skip finishes the run via its original option ID');
  });

  it('posts a choice card for a gate instead of waking an agent directly', async () => {
    const { runId } = await startedRun(OWNER);
    let command = await commandFor(IMPLEMENTER);
    await handoff(database, command, {
      runId,
      outcome: 'pushed',
      contents: { summary: 'x', prUrl: 'y' },
    });
    command = await commandFor(IMPLEMENTER);
    await handoff(database, command, { runId, outcome: 'passing', contents: { headSha: 'abc' } });
    command = await commandFor(REVIEWER);
    const reviewed = await handoff(database, command, {
      runId,
      outcome: 'approved',
      contents: { verdict: 'approve', notes: 'lgtm' },
    });
    expect(reviewed.state).toBe('human_approve');
    const choice = await database.query<{ options: unknown[] }>(
      `SELECT options FROM room_choices WHERE room_id=$1 AND agent_id=$2 AND status='open'`,
      [ROOM, APPROVER],
    );
    expect(choice.rows).toHaveLength(1);
    expect(choice.rows[0]!.options).toHaveLength(2);
    const posted = (await database.query<{ card: { prompt: string; options: { label: string; consequence: string }[] } }>(
      `SELECT card FROM messages WHERE card_type='choice' AND card->>'runId'=$1`, [runId],
    )).rows[0]!.card;
    expect(posted.prompt).not.toBe('corner: human_approve');
    expect(posted.options.map(option => option.label)).toEqual(['approved', 'rejected']);
    expect(posted.options.every(option => !option.consequence.startsWith('go to '))).toBe(true);

  });

  it("applies a person's gate answer as the transition and wakes the next state's agent with its run and attempt", async () => {
    const { runId } = await startedRun(OWNER);
    let command = await commandFor(IMPLEMENTER);
    await handoff(database, command, {
      runId,
      outcome: 'pushed',
      contents: { summary: 'x', prUrl: 'y' },
    });
    command = await commandFor(IMPLEMENTER);
    await handoff(database, command, { runId, outcome: 'passing', contents: { headSha: 'abc' } });
    command = await commandFor(REVIEWER);
    await handoff(database, command, {
      runId,
      outcome: 'approved',
      contents: { verdict: 'approve', notes: 'lgtm' },
    });
    const choice = await database.query<{ id: string; options: { optionId: string; label: string }[] }>(
      `SELECT id,options FROM room_choices WHERE room_id=$1 AND agent_id=$2 AND status='open'`,
      [ROOM, APPROVER],
    );
    expect(choice.rows).toHaveLength(1);
    await expect(answerGate(runId, 'rejected')).resolves.toMatchObject({ status: 'answered' });
    const read = await getWorkflowRun(database, ROOM, runId);
    expect(read).toMatchObject({ state: 'implement', attempt: 4 });
    expect(read.history.at(-1)).toMatchObject({
      fromState: 'human_approve', outcome: 'rejected', actorId: OWNER,
      contents: { decision: 'rejected', answeredBy: OWNER },
    });
    expect(await pendingCommandsFor(APPROVER)).toBe(0);
    const inbox = await readAgentCommands(database, ROOM, IMPLEMENTER);
    const woken = inbox.commands.find((c) => c.source.systemEvent?.verb === 'picked');
    expect(woken?.source.body).toContain(
      `You are in run ${runId} of corner. Continue this run; do not start a new one.`,
    );
    expect(woken?.source.body).toContain('This wake is attempt 4: pass "attempt": 4 to app_tool’s beeline:workflow advance action.');
  });

  it("refuses the bound agent's handoff out of a gate", async () => {
    const { runId } = await startedRun(OWNER);
    await driveToApprovalGate(runId);
    await expect(handoff(database, await commandFor(APPROVER), {
      runId, outcome: 'approved', contents: { decision: 'approved' },
    })).rejects.toThrow('human_approve is a gate; a person answers it on its card in the Room');
    expect((await getWorkflowRun(database, ROOM, runId)).state).toBe('human_approve');
  });

  it("settles a gate from the person's message that started the turn", async () => {
    const { runId } = await startedRun(OWNER);
    const gate = await driveToApprovalGate(runId);
    const source = await rootMessage(OWNER, 'no, rejected');
    const answered = await handoff(database, await commandFor(APPROVER, source), {
      runId, outcome: 'rejected', contents: {},
    });
    expect(answered).toMatchObject({ runId, state: 'implement', attempt: 4 });
    const read = await getWorkflowRun(database, ROOM, runId);
    expect(read.history.at(-1)).toMatchObject({
      fromState: 'human_approve', outcome: 'rejected', actorId: OWNER,
      contents: { decision: 'rejected', answeredBy: OWNER },
      receipt: { exit: { gate: 'rejected', actorId: OWNER, sourceMessageId: source } },
    });
    expect(
      (await database.query<{ status: string }>(`SELECT status FROM room_choices WHERE id=$1`, [gate]))
        .rows[0]?.status,
    ).toBe('answered');
    expect(
      (await database.query<{ voter_id: string }>(
        `SELECT voter_id FROM room_choice_votes WHERE choice_id=$1`,
        [gate],
      )).rows[0]?.voter_id,
    ).toBe(OWNER);
    // The only pending command is this turn's own; settling wakes the next state, not the gate role.
    expect(await pendingCommandsFor(APPROVER)).toBe(1);
    const woken = (await readAgentCommands(database, ROOM, IMPLEMENTER)).commands
      .find((entry) => entry.source.systemEvent?.verb === 'answered');
    expect(woken?.source.body).toContain(
      `You are in run ${runId} of corner. Continue this run; do not start a new one.`,
    );
    // A chat answer reads differently from a card press, and names the message.
    const transition = (
      await database.query<{ text: string }>(
        `SELECT text FROM messages WHERE card_type='workflow-handoff' AND card->>'runId'=$1
           AND card->>'fromState'='human_approve'`,
        [runId],
      )
    ).rows[0];
    expect(transition?.text).toBe(
      `Owner answered rejected · by message at human_approve so run ${runId.slice(0, 8)} went to implement`,
    );
    // The run view also requires the viewer's Workspace membership.
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner')`,
      [WORKSPACE, OWNER],
    );
    // The run view carries the source message on the gate record.
    const detail = await readWorkflowRun(database, { roomId: ROOM, runId }, OWNER);
    const gateRecord = detail?.history.find((entry) => entry.toState === 'human_approve')?.gate;
    expect(gateRecord).toMatchObject({ answer: 'rejected', sourceMessageId: source });
  });

  it('refuses a message-settled gate when the author is not a Room member', async () => {
    const { runId } = await startedRun(OWNER);
    await driveToApprovalGate(runId);
    const source = await rootMessage(OUTSIDER, 'approve please');
    await expect(handoff(database, await commandFor(APPROVER, source), {
      runId, outcome: 'approved', contents: {},
    })).rejects.toThrow('room access denied');
    expect((await getWorkflowRun(database, ROOM, runId)).state).toBe('human_approve');
  });

  it('refuses a message-settled gate whose outcome is not an option', async () => {
    const { runId } = await startedRun(OWNER);
    await driveToApprovalGate(runId);
    const source = await rootMessage(OWNER, 'hmm');
    await expect(handoff(database, await commandFor(APPROVER, source), {
      runId, outcome: 'bogus', contents: {},
    })).rejects.toThrow('outcome must be one of: approved -> land, rejected -> implement');
    expect((await getWorkflowRun(database, ROOM, runId)).state).toBe('human_approve');
  });

  /** Drive a fresh run from `implement` to the open `human_approve` gate; returns its choice id. */
  async function driveToApprovalGate(runId: string): Promise<string> {
    await handoff(database, await commandFor(IMPLEMENTER), {
      runId, outcome: 'pushed', contents: { summary: 'x', prUrl: 'y' },
    });
    await handoff(database, await commandFor(IMPLEMENTER), {
      runId, outcome: 'passing', contents: { headSha: 'abc' },
    });
    await handoff(database, await commandFor(REVIEWER), {
      runId, outcome: 'approved', contents: { verdict: 'approve', notes: 'lgtm' },
    });
    return (
      await database.query<{ id: string }>(
        `SELECT id FROM room_choices WHERE room_id=$1 AND agent_id=$2 AND status='open'`,
        [ROOM, APPROVER],
      )
    ).rows[0]!.id;
  }

  async function startSecondRun(rootAuthorId: string = IMPLEMENTER): Promise<string> {
    const start = await commandFor(IMPLEMENTER, await rootMessage(rootAuthorId));
    return (
      await startWorkflow(database, start, {
        name: 'corner',
        roleBindings: { implementer: IMPLEMENTER, reviewer: REVIEWER, approver: APPROVER },
      })
    ).runId;
  }

  it("settles the first run's gate on its answer and lets a later run reach the gate", async () => {
    // Run 1: implement -> checks -> review -> human_approve, answered to land.
    const { runId: firstRun } = await startedRun(OWNER);
    const firstGate = await driveToApprovalGate(firstRun);
    await answerGate(firstRun, 'approved');
    expect((await getWorkflowRun(database, ROOM, firstRun)).status).toBe('done');
    expect(
      (await database.query<{ status: string }>(`SELECT status FROM room_choices WHERE id=$1`, [firstGate]))
        .rows[0]?.status,
    ).toBe('answered');

    // Run 2 reaches the same gate. Before the fix, run 1's stranded open
    // choice made postWorkflowGate throw 'choice conflict'.
    const secondRun = await startSecondRun(OWNER);
    const secondGate = await driveToApprovalGate(secondRun);
    expect(secondGate).not.toBe(firstGate);
    expect(
      (await database.query<{ run_id: string }>(
        `SELECT message.card->>'runId' run_id FROM room_choices choice
         JOIN messages message ON message.id=choice.message_id WHERE choice.id=$1`,
        [secondGate],
      )).rows[0]?.run_id,
    ).toBe(secondRun);
  });

  it('closes a stranded open choice left by a run that already ended', async () => {
    // Simulate the production row: a run that landed while its gate choice
    // stayed 'open'. The one-open-choice rule and the partial unique index
    // must not let it refuse a later gate.
    const { runId: firstRun } = await startedRun(OWNER);
    const firstGate = await driveToApprovalGate(firstRun);
    await answerGate(firstRun, 'approved');
    await database.query(`UPDATE room_choices SET status='open' WHERE id=$1`, [firstGate]);

    const secondRun = await startSecondRun(OWNER);
    const secondGate = await driveToApprovalGate(secondRun);
    expect(secondGate).not.toBe(firstGate);
    expect(
      (await database.query<{ status: string }>(`SELECT status FROM room_choices WHERE id=$1`, [firstGate]))
        .rows[0]?.status,
    ).toBe('closed');
  });

  it('schedules and cancels a state timeout across a handoff', async () => {
    const timed = {
      ...CONTRACT,
      handoffs: {
        ...CONTRACT.handoffs,
        implement: {
          ...CONTRACT.handoffs.implement,
          on: { ...CONTRACT.handoffs.implement.on, timeout: 'ask_human' },
          timeoutSeconds: 3600,
        },
      },
    };
    const command = await commandFor(IMPLEMENTER);
    await saveWorkflow(database, command, { contract: describedWorkflow(timed)});
    const started = await startWorkflow(database, command, {
      name: 'corner',
      roleBindings: { implementer: IMPLEMENTER, reviewer: REVIEWER, approver: APPROVER },
    });
    const stepTimer = `SELECT id FROM agent_schedules WHERE room_id=$1 AND workflow_run->>'timer'='step'`;
    const before = await database.query(stepTimer, [ROOM]);
    expect(before.rows).toHaveLength(1);
    const next = await commandFor(IMPLEMENTER);
    await handoff(database, next, {
      runId: started.runId,
      outcome: 'pushed',
      contents: { summary: 'x', prUrl: 'y' },
    });
    // The implement state's own timeout is replaced by the next step's; the
    // run's deadline stays.
    const left = await database.query<{ timer: string; attempt: string | null }>(
      `SELECT workflow_run->>'timer' timer,workflow_run->>'attempt' attempt FROM agent_schedules WHERE room_id=$1 ORDER BY 1`, [ROOM],
    );
    expect(left.rows).toEqual([{ timer: 'deadline', attempt: null }, { timer: 'step', attempt: '1' }]);
  });

  it('applies timeout itself as the system once the role list is used up, skipping the state requires', async () => {
    const timed = {
      ...CONTRACT,
      handoffs: {
        ...CONTRACT.handoffs,
        implement: {
          ...CONTRACT.handoffs.implement,
          on: { ...CONTRACT.handoffs.implement.on, timeout: 'ask_human' },
          timeoutSeconds: 3600,
        },
      },
    };
    const command = await commandFor(IMPLEMENTER);
    await saveWorkflow(database, command, { contract: describedWorkflow(timed)});
    const { runId } = await startWorkflow(database, command, {
      name: 'corner',
      roleBindings: { implementer: IMPLEMENTER, reviewer: REVIEWER, approver: APPROVER },
    });
    await database.query(
      `UPDATE agent_schedules SET next_run_at=now()-interval '1 minute' WHERE room_id=$1 AND workflow_run->>'timer'='step'`,
      [ROOM],
    );
    expect(await new AgentScheduleLoop(database).runOnce()).toBe(1);
    // No wake asks the silent agent to pick `timeout`: the engine applied it.
    expect((await readAgentCommands(database, ROOM, IMPLEMENTER)).commands
      .some((item) => item.source.systemEvent?.kind === 'schedule-ran')).toBe(false);
    const read = await getWorkflowRun(database, ROOM, runId);
    expect(read.state).toBe('ask_human');
    const last = read.history.at(-1)!;
    expect(last).toMatchObject({ fromState: 'implement', outcome: 'timeout', actorId: SYSTEM_IDENTITY_ID });
    expect((last.contents as { reason: string }).reason).toBe('@impy its lease expired');
    const line = (await database.query<{ text: string }>(`SELECT text FROM messages WHERE id=$1`, [last.messageId])).rows[0]!;
    expect(line.text).toBe(
      `the workflow applied timeout · at implement and went to ask_human because nobody on the implementer role is left (@impy its lease expired) in run ${runId.slice(0, 8)} of corner`,
    );
  });
});

describe('a gate handing directly into another gate', () => {
  it("closes the state being left but never the freshly posted next gate's choice", async () => {
    const chain = {
      version: 1,
      name: 'gate-chain',
      description: 'Two gates back to back',
      roles: ['approver'],
      start: 'gate_a',
      handoffs: {
        gate_a: { kind: 'gate', role: 'approver', requires: ['decision'], on: { go: 'gate_b', stop: 'failed' } },
        gate_b: { kind: 'gate', role: 'approver', requires: ['decision'], on: { go: 'land', stop: 'failed' } },
        land: { kind: 'terminal', status: 'done' },
        failed: { kind: 'terminal', status: 'failed' },
      },
    };
    const command = await commandFor(APPROVER, await rootMessage(OWNER));
    await saveWorkflow(database, command, { contract: describedWorkflow(chain) });
    const { runId } = await startWorkflow(database, command, {
      name: 'gate-chain',
      roleBindings: { approver: APPROVER },
    });
    const gateAChoice = (
      await database.query<{ id: string }>(
        `SELECT id FROM room_choices WHERE room_id=$1 AND agent_id=$2 AND status='open'`,
        [ROOM, APPROVER],
      )
    ).rows[0]!;
    // A person's answer takes gate_a straight into gate_b within this single transaction.
    await answerGate(runId, 'go');
    expect((await getWorkflowRun(database, ROOM, runId)).state).toBe('gate_b');
    expect(
      (await database.query<{ status: string }>(`SELECT status FROM room_choices WHERE id=$1`, [gateAChoice.id]))
        .rows[0]?.status,
    ).toBe('answered');
    const gateBChoice = (
      await database.query<{ status: string }>(
        `SELECT status FROM room_choices WHERE room_id=$1 AND agent_id=$2 AND id<>$3`,
        [ROOM, APPROVER, gateAChoice.id],
      )
    ).rows[0];
    expect(gateBChoice?.status).toBe('open');
  });
});

describe('closeStaleWorkflowGateChoices', () => {
  it('closes a row left open from before this fix shipped, idempotently', async () => {
    const { runId } = await startedRun(OWNER);
    await driveToApprovalGate(runId);
    const choice = (
      await database.query<{ id: string }>(
        `SELECT id FROM room_choices WHERE room_id=$1 AND agent_id=$2 AND status='open'`,
        [ROOM, APPROVER],
      )
    ).rows[0]!;
    await answerGate(runId, 'approved');
    // Simulates a row left over from before this fix shipped: the answer
    // above already settled it, so put it back open by hand to reproduce what
    // a pre-fix production row looked like.
    await database.query(`UPDATE room_choices SET status='open' WHERE id=$1`, [choice.id]);

    expect(await closeStaleWorkflowGateChoices(database)).toBe(1);
    expect(
      (await database.query<{ status: string }>(`SELECT status FROM room_choices WHERE id=$1`, [choice.id]))
        .rows[0]?.status,
    ).toBe('closed');
    expect(await closeStaleWorkflowGateChoices(database)).toBe(0);
  });

  it('leaves a still-live gate alone', async () => {
    const { runId } = await startedRun(OWNER);
    await driveToApprovalGate(runId);
    const choice = (
      await database.query<{ id: string }>(
        `SELECT id FROM room_choices WHERE room_id=$1 AND agent_id=$2 AND status='open'`,
        [ROOM, APPROVER],
      )
    ).rows[0]!;
    expect(await closeStaleWorkflowGateChoices(database)).toBe(0);
    expect(
      (await database.query<{ status: string }>(`SELECT status FROM room_choices WHERE id=$1`, [choice.id]))
        .rows[0]?.status,
    ).toBe('open');
  });
});

describe('gates and exhausted roles for an agent-started run', () => {
  it('posts the gate card for a person even when an agent started the run, and wakes no agent', async () => {
    const { runId } = await startedRun(); // default root author: IMPLEMENTER (agent)
    await handoff(database, await commandFor(IMPLEMENTER), {
      runId, outcome: 'pushed', contents: { summary: 'x', prUrl: 'y' },
    });
    await handoff(database, await commandFor(IMPLEMENTER), {
      runId, outcome: 'passing', contents: { headSha: 'abc' },
    });
    const reviewed = await handoff(database, await commandFor(REVIEWER), {
      runId, outcome: 'approved', contents: { verdict: 'approve', notes: 'lgtm' },
    });
    expect(reviewed.state).toBe('human_approve');
    const choice = await database.query<{ attempt: string }>(
      `SELECT message.card->>'attempt' attempt FROM room_choices choice JOIN messages message ON message.id=choice.message_id
       WHERE choice.room_id=$1 AND choice.status='open' AND message.card->>'runId'=$2`, [ROOM, runId],
    );
    expect(choice.rows).toEqual([{ attempt: '3' }]);
    const runWakes = await database.query(
      `SELECT 1 FROM agent_commands command JOIN messages message ON message.id=command.source_message_id
       WHERE command.state='pending' AND message.card->>'runId'=$1`,
      [runId],
    );
    expect(runWakes.rowCount).toBe(0);
  });

  it('still posts the human choice card and wakes nobody else when a human started the run', async () => {
    const { runId } = await startedRun(OWNER);
    await handoff(database, await commandFor(IMPLEMENTER), {
      runId, outcome: 'pushed', contents: { summary: 'x', prUrl: 'y' },
    });
    await handoff(database, await commandFor(IMPLEMENTER), {
      runId, outcome: 'passing', contents: { headSha: 'abc' },
    });
    await handoff(database, await commandFor(REVIEWER), {
      runId, outcome: 'approved', contents: { verdict: 'approve', notes: 'lgtm' },
    });
    const choice = await database.query(
      `SELECT 1 FROM room_choices WHERE room_id=$1 AND agent_id=$2 AND status='open'`, [ROOM, APPROVER],
    );
    expect(choice.rows).toHaveLength(1);
    const inbox = await readAgentCommands(database, ROOM, IMPLEMENTER);
    expect(inbox.commands.find((c) => c.source.systemEvent?.verb === 'reached a gate at')).toBeUndefined();
  });

  it('wakes the agent starter when an agent-started list role is exhausted, not just a passive note', async () => {
    await reportPresence(WORKER_A, 'offline');
    await reportPresence(WORKER_B, 'offline');
    await startedListRun(); // default starter: IMPLEMENTER (agent)
    const inbox = await readAgentCommands(database, ROOM, IMPLEMENTER);
    const woken = inbox.commands.find((c) => c.source.body.includes("worker role's list"));
    expect(woken).toBeDefined();
  });

  it('names each agent and its reason, and wakes the agent starter, when a single-bound role fails', async () => {
    const { runId } = await startedListRun();
    await handoff(database, await commandFor(WORKER_A), {
      runId, outcome: 'done', contents: { note: 'finished' },
    });
    const dispatchId = (
      await database.query<{ id: string }>(
        `SELECT id FROM messages WHERE card_type='workflow-handoff' AND card->>'runId'=$1
         ORDER BY (card->>'seq')::int DESC LIMIT 1`,
        [runId],
      )
    ).rows[0]!.id;
    // A single-bound role has no list to fail over on; the no-op before this
    // feature left nobody woken at all.
    await reassignFailedWorkflowRole(database, {
      roomId: ROOM,
      requestId: dispatchId,
      agentId: APPROVER,
      reason: 'provider timeout',
    });
    expect((await listRunCard(runId)).roleBindings.closer).toBe(APPROVER);
    const inbox = await readAgentCommands(database, ROOM, IMPLEMENTER);
    const woken = inbox.commands.find((c) => c.source.body.includes(runId));
    expect(woken).toBeDefined();
    expect(woken!.source.body).toContain("closer role's list");
    expect(woken!.source.body).toContain('@ada its turn failed (provider timeout)');
  });
});

describe('archive_workflow', () => {
  it('archives a workflow so a later start_workflow refuses it', async () => {
    const command = await commandFor(IMPLEMENTER);
    await saveWorkflow(database, command, { contract: describedWorkflow(CONTRACT)});
    // Its saving agent may not archive it; a Workspace admin may.
    await expect(archiveWorkflow(database, command, { name: 'corner' })).rejects.toThrow('workspace admins only');
    const archived = await archiveWorkflow(database, await adminCommand(), { name: 'corner' });
    expect(archived).toEqual({ slug: 'corner', archived: true });
    await expect(
      startWorkflow(database, command, {
        name: 'corner',
        roleBindings: { implementer: IMPLEMENTER, reviewer: REVIEWER, approver: APPROVER },
      }),
    ).rejects.toThrow('workflow is unavailable');
  });

  it('keeps a run in flight on its pinned version after the workflow is archived', async () => {
    const { runId } = await startedRun();
    const command = await commandFor(IMPLEMENTER);
    await archiveWorkflow(database, await adminCommand(), { name: 'corner' });
    const result = await handoff(database, command, {
      runId,
      outcome: 'pushed',
      contents: { summary: 'x', prUrl: 'y' },
    });
    expect(result.state).toBe('checks');
  });
});

/**
 * P0-1 (external review of PR #1909): handoff() derived a run's current
 * state, validated the caller's requested transition against it, and wrote
 * the next `workflow-handoff` card with NO lock around that whole sequence —
 * only the narrower loop-edge count had one. Two concurrent handoffs from
 * the same state (a duplicate/retried tool call is exactly the "hiccup"
 * pattern this codebase's own command-delivery layer already produces) could
 * both read the same current state under READ COMMITTED, both validate
 * independently, and both write a card; whichever committed last would
 * silently become the run's canonical state per loadRun's newest-card-wins
 * derivation, discarding the other transition even though its wake had
 * already fired.
 *
 * PGlite cannot exhibit that race directly: it is a single embedded WASM
 * connection guarded by its own internal mutex, so `database.transaction()`
 * calls fully serialize — one call's BEGIN...COMMIT always completes before
 * the next one's BEGIN begins, which is also why no test here (or anywhere
 * else in this codebase, for the identical `resolveCascade` root lock or the
 * pre-existing loop-edge lock) can force two genuinely concurrent Postgres
 * connections to interleave. What CAN be proven, and is proven below, is
 * that the code takes the run-level lock as the very first statement of the
 * transaction, before it reads anything — which is the actual fix, and the
 * assertion genuinely fails against the pre-fix code (no such call existed
 * at all) and passes against the fix.
 */
describe('handoff run-level locking (P0-1)', () => {
  it('derives the same lock key start_workflow and handoff both use', () => {
    expect(workflowRunLockKey('abc123')).toBe('workflow-run:abc123');
  });

  it("acquires the run lock as the transaction's first statement, before it reads the run's current state", async () => {
    const { runId } = await startedRun();
    const recording = new RecordingDatabase(database);
    await handoff(recording, await commandFor(IMPLEMENTER), {
      runId,
      outcome: 'pushed',
      contents: { summary: 'x', prUrl: 'y' },
    });
    expect(recording.calls[0]).toEqual({
      sql: 'SELECT pg_advisory_xact_lock(hashtext($1))',
      values: [workflowRunLockKey(runId)],
    });
    const readIndex = recording.calls.findIndex((call) => call.sql.includes('FROM messages'));
    expect(readIndex).toBeGreaterThan(0);
  });

  it('resolves a prefix before locking the canonical run ID and reading its state', async () => {
    const { runId } = await startedRun();
    const recording = new RecordingDatabase(database);
    const command = await commandFor(IMPLEMENTER, runId);
    const result = await handoff(recording, command, {
      runId: runId.slice(0, 8), outcome: 'pushed', contents: { summary: 'ready', prUrl: 'proof' },
    });
    expect(result.runId).toBe(runId);
    const lockIndex = recording.calls.findIndex(call => call.sql.includes('pg_advisory_xact_lock'));
    expect(recording.calls[lockIndex]!.values).toEqual([workflowRunLockKey(runId)]);
    const stateIndex = recording.calls.findIndex(call => call.sql.includes('ORDER BY (card->>'));
    expect(stateIndex).toBeGreaterThan(lockIndex);
    expect(recording.calls[stateIndex]!.values).toContain(runId);
    expect(await handoff(recording, command, {
      runId: runId.slice(0, 8), outcome: 'pushed', contents: { summary: 'ready', prUrl: 'proof' },
    })).toEqual(result);
    expect((await getWorkflowRun(database, ROOM, runId)).history).toHaveLength(2);
  });

  it("start_workflow locks its freshly minted run id before writing the run's start card", async () => {
    const command = await commandFor(IMPLEMENTER);
    await saveWorkflow(database, command, { contract: describedWorkflow(CONTRACT)});
    const recording = new RecordingDatabase(database);
    const { runId } = await startWorkflow(recording, command, {
      name: 'corner',
      roleBindings: { implementer: IMPLEMENTER, reviewer: REVIEWER, approver: APPROVER },
    });
    const lockIndex = recording.calls.findIndex(
      (call) =>
        call.sql === 'SELECT pg_advisory_xact_lock(hashtext($1))' &&
        call.values?.[0] === workflowRunLockKey(runId),
    );
    const insertIndex = recording.calls.findIndex((call) => call.sql.includes('INSERT INTO messages'));
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(insertIndex).toBeGreaterThan(lockIndex);
  });

  it('keeps loop counts exact and every card internally consistent across handoffs fired together', async () => {
    // PGlite fully serializes database.transaction() calls (see the
    // docblock above), so this cannot force the true interleaving the fix
    // guards against — that is proven by the call-order tests above
    // instead. This test is a regression safety net: whatever order PGlite
    // actually runs these two calls in, the result must be internally
    // consistent (the run ends up at exactly one real state, and the loop
    // count computed for whichever call takes the capped edge reflects
    // reality) rather than corrupted.
    const { runId } = await startedRun();
    const implementer = await commandFor(IMPLEMENTER);
    await handoff(database, implementer, {
      runId,
      outcome: 'pushed',
      contents: { summary: 'x', prUrl: 'y' },
    });
    const [a, b] = await Promise.allSettled([
      handoff(database, await commandFor(IMPLEMENTER), {
        runId,
        outcome: 'passing',
        contents: { headSha: 'sha-a' },
      }),
      handoff(database, await commandFor(IMPLEMENTER), {
        runId,
        outcome: 'failing',
        contents: { headSha: 'sha-b' },
      }),
    ]);
    // Both calls read/validated/wrote against the SAME source state
    // ("checks"), which is only valid once — the second one to actually run
    // sees the first one's committed card and is bound to whatever role
    // that landed on, not "implementer" (this is the run-level lock doing
    // its job: it forces true sequencing, so the second call's view of
    // "current state" is never stale).
    const outcomes = [a, b];
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const cards = await database.query<{ card: { fromState: string; outcome: string; toState: string } }>(
      `SELECT card FROM messages WHERE room_id=$1 AND card_type='workflow-handoff'
       AND card->>'runId'=$2 ORDER BY created_at,id`,
      [ROOM, runId],
    );
    // Exactly one card was ever written for the "checks" state, not two
    // conflicting ones racing to be "the" current state.
    const fromChecks = cards.rows.filter((row) => row.card.fromState === 'checks');
    expect(fromChecks).toHaveLength(1);
  });
});

describe('per-run sequence (S05-1)', () => {
  it('continues from a same-transaction handoff and reassignment with descending IDs', async () => {
    const starter = await commandFor(IMPLEMENTER);
    const workerA = await commandFor(WORKER_A);
    const workerB = await commandFor(WORKER_B);
    const closer = await commandFor(APPROVER);
    await saveWorkflow(database, starter, { contract: describedWorkflow(LIST_CONTRACT)});
    await database.transaction(async (db) => {
      vi.mocked(randomBytes).mockImplementationOnce(() => Buffer.alloc(32, 0xff));
      const { runId } = await startWorkflow(db, starter, {
        name: 'list-flow',
        roleBindings: { worker: [WORKER_A, WORKER_B], closer: APPROVER },
      });
      vi.mocked(randomBytes).mockImplementationOnce(() => Buffer.alloc(32, 0xee));
      await handoff(db, workerA, { runId, outcome: 'retry', contents: { note: 'retry' } });
      vi.mocked(randomBytes).mockImplementationOnce(() => Buffer.alloc(32, 0x11));
      await assignWorkflowRole(db, starter, { runId, role: 'worker', targetAgentId: WORKER_B });
      const cards = (
        await db.query<{ id: string; seq: number; at: Date }>(
          `SELECT id,(card->>'seq')::int seq,created_at at FROM messages
         WHERE card->>'runId'=$1 AND card_type='workflow-handoff'
         ORDER BY (card->>'seq')::int NULLS LAST,id DESC`,
          [runId],
        )
      ).rows;
      expect(cards.map((card) => card.id)).toEqual([
        'ff'.repeat(32),
        'ee'.repeat(32),
        '11'.repeat(32),
      ]);
      expect(new Set(cards.map((card) => card.at.getTime())).size).toBe(1);
      // This fails with timestamp/ID ordering: it still binds work to WorkerA.
      vi.mocked(randomBytes).mockImplementationOnce(() => Buffer.alloc(32, 0));
      expect(
        await handoff(db, workerB, { runId, outcome: 'done', contents: { note: 'finished' } }),
      ).toMatchObject({ state: 'close' });
      expect(cards.map((card) => card.seq)).toEqual([0, 1, 2]);
      expect(
        (
          await db.query(
            `SELECT 1 FROM agent_commands WHERE agent_id=$1 AND source_message_id=$2`,
            [WORKER_B, '11'.repeat(32)],
          )
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await db.query(
            `SELECT 1 FROM agent_commands WHERE agent_id=$1 AND source_message_id=$2`,
            [APPROVER, '00'.repeat(32)],
          )
        ).rowCount,
      ).toBe(1);
      expect(
        await handoff(db, closer, { runId, outcome: 'done', contents: { note: 'closed' } }),
      ).toMatchObject({ state: 'land', status: 'done' });
      console.info(
        'Reproduction S05-1: same-transaction descending IDs → WorkerB continued work → close woke Approver → land',
      );
    });
  });

  it('fails over the newest dispatch and ignores the superseded higher-ID dispatch', async () => {
    const starter = await commandFor(IMPLEMENTER);
    const worker = await commandFor(WORKER_A);
    await saveWorkflow(database, starter, { contract: describedWorkflow(LIST_CONTRACT)});
    await database.transaction(async (db) => {
      vi.mocked(randomBytes).mockImplementationOnce(() => Buffer.alloc(32, 0xff));
      const { runId } = await startWorkflow(db, starter, {
        name: 'list-flow',
        roleBindings: { worker: [WORKER_A, WORKER_B], closer: APPROVER },
      });
      vi.mocked(randomBytes).mockImplementationOnce(() => Buffer.alloc(32, 0x11));
      await handoff(db, worker, { runId, outcome: 'retry', contents: { note: 'retry' } });
      vi.mocked(randomBytes).mockImplementationOnce(() => Buffer.alloc(32, 0));
      await reassignFailedWorkflowRole(db, {
        roomId: ROOM,
        requestId: '11'.repeat(32),
        agentId: WORKER_A,
      });
      expect(
        (
          await db.query<{ card: { seq: number; roleBindings: Record<string, string> } }>(
            `SELECT card FROM messages WHERE id=$1`,
            ['00'.repeat(32)],
          )
        ).rows[0]?.card,
      ).toMatchObject({ seq: 2, roleBindings: { worker: WORKER_B } });
      expect(
        (
          await db.query(
            `SELECT 1 FROM agent_commands WHERE agent_id=$1 AND source_message_id=$2`,
            [WORKER_B, '00'.repeat(32)],
          )
        ).rowCount,
      ).toBe(1);
      await reassignFailedWorkflowRole(db, { roomId: ROOM, requestId: runId, agentId: WORKER_A });
      expect(
        (
          await db.query(
            `SELECT 1 FROM messages WHERE card->>'runId'=$1 AND card->>'reassigned'='true'`,
            [runId],
          )
        ).rowCount,
      ).toBe(1);
    });
  });

  it('sequences a legacy run from one and continues above its unsequenced card', async () => {
    const { runId } = await startedListRun();
    await database.query(`UPDATE messages SET card=card-'seq' WHERE id=$1`, [runId]);
    await normalizeLegacyWorkflowRuns(database);
    await handoff(database, await commandFor(WORKER_A), {
      runId,
      outcome: 'retry',
      contents: { note: 'legacy retry' },
    });
    const latest = (
      await database.query<{ id: string; card: { seq: number } }>(
        `SELECT id,card FROM messages WHERE card->>'runId'=$1 AND id<>$1`,
        [runId],
      )
    ).rows[0]!;
    expect(latest.card.seq).toBe(1);
    // Even a legacy timestamp ahead of the sequenced card must not displace it.
    await database.query(`UPDATE messages SET created_at=now()+interval '1 day' WHERE id=$1`, [
      runId,
    ]);
    await database.transaction((db) =>
      reassignFailedWorkflowRole(db, {
        roomId: ROOM,
        requestId: latest.id,
        agentId: WORKER_A,
      }),
    );
    expect(await listRunCard(runId)).toMatchObject({ seq: 2, roleBindings: { worker: WORKER_B } });
    expect(
      await handoff(database, await commandFor(WORKER_B), {
        runId,
        outcome: 'done',
        contents: { note: 'finished' },
      }),
    ).toMatchObject({ state: 'close' });
    expect(await listRunCard(runId)).toMatchObject({ seq: 3 });
  });
});
