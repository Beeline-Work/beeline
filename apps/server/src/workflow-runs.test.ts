import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { createAgentCommand, type CommandRow } from './agent-command.js';
import { answerRoomChoice } from './room-choice.js';
import { archiveWorkflow, handoff, saveWorkflow, startWorkflow } from './workflow-runs.js';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const ROOM = '20000000-0000-4000-8000-000000000001';
const OWNER = 'a'.repeat(64);
const IMPLEMENTER = 'b'.repeat(64);
const REVIEWER = 'c'.repeat(64);
const APPROVER = 'd'.repeat(64);
const OUTSIDER = 'e'.repeat(64);

let database: PgliteDatabase;

const CONTRACT = {
  version: 1,
  name: 'corner',
  description: 'Implement, get checks green, get reviewed, and land a change',
  roles: ['implementer', 'reviewer', 'approver'],
  start: 'implement',
  handoffs: {
    implement: {
      role: 'implementer',
      requires: ['summary', 'prUrl'],
      on: { pushed: 'checks', blocked: 'ask_human' },
    },
    checks: {
      role: 'implementer',
      requires: ['headSha'],
      on: { passing: 'review', failing: 'implement' },
      loop: { onEdge: 'failing', cap: 2, onExceeded: 'ask_human' },
    },
    review: {
      role: 'reviewer',
      requires: ['verdict', 'notes'],
      on: { approved: 'human_approve', changes_requested: 'implement' },
      loop: { onEdge: 'changes_requested', cap: 2, onExceeded: 'ask_human' },
    },
    human_approve: {
      kind: 'gate',
      role: 'approver',
      requires: ['decision'],
      on: { approved: 'land', rejected: 'implement' },
    },
    ask_human: {
      kind: 'gate',
      role: 'approver',
      requires: ['decision'],
      on: { resume: 'implement', abandon: 'failed' },
    },
    land: { kind: 'terminal', status: 'done' },
    failed: { kind: 'terminal', status: 'failed' },
  },
};

async function rootMessage(authorId: string, text = 'kick off the workflow'): Promise<string> {
  const id = `${authorId}-root-${Math.random().toString(16).slice(2)}`;
  await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)`, [
    id,
    ROOM,
    authorId,
    text,
  ]);
  return id;
}

async function commandFor(agentId: string, sourceMessageId?: string): Promise<CommandRow> {
  const sourceId = sourceMessageId ?? (await rootMessage(agentId === OWNER ? OWNER : IMPLEMENTER));
  const command = await createAgentCommand(database, {
    roomId: ROOM,
    agentId,
    sourceMessageId: sourceId,
    reason: 'test',
  });
  if (!command) throw new Error('failed to create test command');
  return command;
}

async function pendingCommandsFor(agentId: string): Promise<number> {
  const rows = await database.query<{ count: string }>(
    `SELECT count(*)::text count FROM agent_commands WHERE room_id=$1 AND agent_id=$2 AND state='pending'`,
    [ROOM, agentId],
  );
  return Number(rows.rows[0]?.count ?? 0);
}

beforeEach(async () => {
  database = new PgliteDatabase();
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name) VALUES
       ($1,'human','Owner'),($2,'agent','Impy'),($3,'agent','Ravi'),($4,'agent','Ada'),($5,'human','Outsider')`,
    [OWNER, IMPLEMENTER, REVIEWER, APPROVER, OUTSIDER],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [WORKSPACE]);
  await database.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Team')`, [
    ROOM,
    WORKSPACE,
    OWNER,
  ]);
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES
       ($1,$2,$3,'owner'),($1,$2,$4,'member'),($1,$2,$5,'member'),($1,$2,$6,'member')`,
    [WORKSPACE, ROOM, OWNER, IMPLEMENTER, REVIEWER, APPROVER],
  );
});

describe('save_workflow', () => {
  it('saves a valid contract as version 1', async () => {
    const command = await commandFor(IMPLEMENTER);
    const result = await saveWorkflow(database, command, { contract: CONTRACT });
    expect(result).toEqual({ slug: 'corner', version: 1 });
    const row = await database.query<{ kind: string; state: string; current_version: number }>(
      `SELECT kind,state,current_version FROM workspace_skills WHERE workspace_id=$1 AND slug='corner'`,
      [WORKSPACE],
    );
    expect(row.rows[0]).toEqual({ kind: 'workflow', state: 'active', current_version: 1 });
  });

  it('bumps the version on a second save of the same name', async () => {
    const command = await commandFor(IMPLEMENTER);
    await saveWorkflow(database, command, { contract: CONTRACT });
    const changed = { ...CONTRACT, description: 'Updated description' };
    const second = await saveWorkflow(database, command, { contract: changed });
    expect(second).toEqual({ slug: 'corner', version: 2 });
  });

  it('rejects an uncapped loop', async () => {
    const command = await commandFor(IMPLEMENTER);
    const broken = {
      ...CONTRACT,
      handoffs: { ...CONTRACT.handoffs, checks: { ...CONTRACT.handoffs.checks, loop: undefined } },
    };
    await expect(saveWorkflow(database, command, { contract: broken })).rejects.toThrow(
      'workflow contract is invalid',
    );
  });

  it('rejects a contract naming an unknown role', async () => {
    const command = await commandFor(IMPLEMENTER);
    const broken = {
      ...CONTRACT,
      handoffs: { ...CONTRACT.handoffs, implement: { ...CONTRACT.handoffs.implement, role: 'ghost' } },
    };
    await expect(saveWorkflow(database, command, { contract: broken })).rejects.toThrow(
      'workflow contract is invalid',
    );
  });
});

describe('start_workflow', () => {
  it('rejects a role with no binding', async () => {
    const command = await commandFor(IMPLEMENTER);
    await saveWorkflow(database, command, { contract: CONTRACT });
    await expect(
      startWorkflow(database, command, {
        name: 'corner',
        roleBindings: { implementer: IMPLEMENTER, reviewer: REVIEWER },
      }),
    ).rejects.toThrow('role binding is missing for approver');
  });

  it('rejects a role bound to someone who is not a current Room member', async () => {
    const command = await commandFor(IMPLEMENTER);
    await saveWorkflow(database, command, { contract: CONTRACT });
    await expect(
      startWorkflow(database, command, {
        name: 'corner',
        roleBindings: { implementer: IMPLEMENTER, reviewer: REVIEWER, approver: 'f'.repeat(64) },
      }),
    ).rejects.toThrow('is not a current member of this Room');
  });

  it('posts a run and wakes the start role agent', async () => {
    const command = await commandFor(IMPLEMENTER);
    await saveWorkflow(database, command, { contract: CONTRACT });
    const started = await startWorkflow(database, command, {
      name: 'corner',
      roleBindings: { implementer: IMPLEMENTER, reviewer: REVIEWER, approver: APPROVER },
    });
    expect(started.state).toBe('implement');
    expect(await pendingCommandsFor(IMPLEMENTER)).toBeGreaterThan(0);
    const card = await database.query<{ card_type: string }>(
      `SELECT card_type FROM messages WHERE id=$1`,
      [started.runId],
    );
    expect(card.rows[0]?.card_type).toBe('workflow-handoff');
  });
});

async function startedRun(): Promise<{ runId: string }> {
  const command = await commandFor(IMPLEMENTER);
  await saveWorkflow(database, command, { contract: CONTRACT });
  return startWorkflow(database, command, {
    name: 'corner',
    roleBindings: { implementer: IMPLEMENTER, reviewer: REVIEWER, approver: APPROVER },
  });
}

describe('handoff', () => {
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
  });

  it('rejects a handoff on a run that has already ended', async () => {
    const { runId } = await startedRun();
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
    const approvedOption = choice.rows[0]!.options.find((option) => option.label === 'approved')!;
    await answerRoomChoice(database, {
      choiceId: choice.rows[0]!.id,
      optionId: approvedOption.optionId,
      viewerId: OWNER,
    });
    command = await commandFor(APPROVER);
    const landed = await handoff(database, command, {
      runId,
      outcome: 'approved',
      contents: { decision: 'approved' },
    });
    expect(landed).toEqual({ runId, state: 'land', status: 'done' });
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

  it('posts a choice card for a gate instead of waking an agent directly', async () => {
    const { runId } = await startedRun();
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
    await saveWorkflow(database, command, { contract: timed });
    const started = await startWorkflow(database, command, {
      name: 'corner',
      roleBindings: { implementer: IMPLEMENTER, reviewer: REVIEWER, approver: APPROVER },
    });
    const before = await database.query(`SELECT id FROM agent_schedules WHERE room_id=$1`, [ROOM]);
    expect(before.rows).toHaveLength(1);
    const next = await commandFor(IMPLEMENTER);
    await handoff(database, next, {
      runId: started.runId,
      outcome: 'pushed',
      contents: { summary: 'x', prUrl: 'y' },
    });
    // The implement state's own timeout is cancelled once it resolves normally.
    const after = await database.query(`SELECT id FROM agent_schedules WHERE room_id=$1`, [ROOM]);
    expect(after.rows).toHaveLength(0);
  });
});

describe('archive_workflow', () => {
  it('archives a workflow so a later start_workflow refuses it', async () => {
    const command = await commandFor(IMPLEMENTER);
    await saveWorkflow(database, command, { contract: CONTRACT });
    const archived = await archiveWorkflow(database, command, { name: 'corner' });
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
    await archiveWorkflow(database, command, { name: 'corner' });
    const result = await handoff(database, command, {
      runId,
      outcome: 'pushed',
      contents: { summary: 'x', prUrl: 'y' },
    });
    expect(result.state).toBe('checks');
  });
});
