import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { createAgentCommand, type CommandRow } from './agent-command.js';
import { advanceCorner, ensureCornerWorkflowSeeded } from './corner-workflow.js';
import { PhoneService } from './phone-service.js';
import { handoff, saveWorkflow, startWorkflow } from './workflow-runs.js';

/**
 * The phone's workflow run reads over real `workflow-handoff` cards written by
 * `startWorkflow`/`handoff`, and a corner's own lifecycle cards written by
 * `advanceCorner` — never hand-built rows.
 */

const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const ROOM = '20000000-0000-4000-8000-000000000001';
const CORNER = '30000000-0000-4000-8000-000000000001';
const OTHER_ROOM = '40000000-0000-4000-8000-000000000001';
const OWNER = 'a'.repeat(64);
const TRIAGER = 'b'.repeat(64);
const REVIEWER = 'c'.repeat(64);
const OUTSIDER = 'e'.repeat(64);

const TRIAGE = {
  version: 1,
  name: 'feedback-triage',
  description: 'Daily feedback sweep',
  roles: ['triager'],
  start: 'pull',
  handoffs: {
    pull: {
      role: 'triager',
      requires: [],
      on: { ranked: 'approve', nothing_new: 'done', retry: 'pull' },
      loop: { onEdge: 'retry', cap: 3, onExceeded: 'done' },
    },
    approve: {
      kind: 'gate',
      role: 'triager',
      requires: [],
      on: { dispatch: 'dispatch', skip: 'done' },
    },
    dispatch: { role: 'triager', requires: [], on: { dispatched: 'done' } },
    done: { kind: 'terminal', status: 'done' },
  },
};

let database: PgliteDatabase;
let phone: PhoneService;

async function command(roomId: string, agentId: string): Promise<CommandRow> {
  const id = `root-${Math.random().toString(16).slice(2)}`;
  await database.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'go')`, [
    id,
    roomId,
    OWNER,
  ]);
  const created = await createAgentCommand(database, {
    roomId,
    agentId,
    sourceMessageId: id,
    reason: 'test',
  });
  if (!created) throw new Error('no command');
  return created;
}

beforeEach(async () => {
  database = new PgliteDatabase();
  await migrate(database);
  await database.query(
    `INSERT INTO identities(id,kind,name) VALUES
       ($1,'human','Owner'),($2,'agent','Candy'),($3,'agent','Hoots'),($4,'human','Outsider')`,
    [OWNER, TRIAGER, REVIEWER, OUTSIDER],
  );
  await database.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [WORKSPACE]);
  await database.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name,reviewer_agent_id) VALUES
       ($1,$3,$4,'beeline',$5),($2,$3,$4,'elsewhere',NULL)`,
    [ROOM, OTHER_ROOM, WORKSPACE, OWNER, REVIEWER],
  );
  await database.query(
    `INSERT INTO rooms(id,workspace_id,created_by,name,parent_id) VALUES($1,$2,$3,'Issues triage',$4)`,
    [CORNER, WORKSPACE, OWNER, ROOM],
  );
  await database.query(
    `INSERT INTO corner_facts(corner_id,owner_agent_id,commissioned_by,objective)
     VALUES($1,$2,$3,'Run the feedback sweep')`,
    [CORNER, TRIAGER, OWNER],
  );
  for (const who of [OWNER, TRIAGER, REVIEWER, OUTSIDER])
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'member')`,
      [WORKSPACE, who],
    );
  for (const roomId of [ROOM, CORNER])
    for (const who of [OWNER, TRIAGER, REVIEWER])
      await database.query(
        `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
        [WORKSPACE, roomId, who],
      );
  await database.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
    [WORKSPACE, OTHER_ROOM, OUTSIDER],
  );
  await ensureCornerWorkflowSeeded(database, WORKSPACE, ROOM);
  phone = new PhoneService(database, 'http://test');
});
afterEach(async () => database.close());

async function triageRun(): Promise<string> {
  await saveWorkflow(database, await command(CORNER, TRIAGER), { contract: TRIAGE });
  const { runId } = await startWorkflow(database, await command(CORNER, TRIAGER), {
    name: 'feedback-triage',
    roleBindings: { triager: TRIAGER },
  });
  // Loop once, then rank: the run now waits at the approve gate.
  await handoff(database, await command(CORNER, TRIAGER), { runId, outcome: 'retry', contents: {} });
  await handoff(database, await command(CORNER, TRIAGER), { runId, outcome: 'ranked', contents: {} });
  return runId;
}

describe('listRoomWorkflowRuns', () => {
  it("lists each workflow's newest run in the Room and its corners, with its state and holder", async () => {
    const runId = await triageRun();
    await advanceCorner(database, CORNER, {
      kind: 'open',
      lane: 'code',
      workspaceId: WORKSPACE,
      implementerAgentId: TRIAGER,
    });
    const listed = await phone.execute('listRoomWorkflowRuns', { roomId: ROOM }, OWNER);
    const bySlug = Object.fromEntries(listed.workflows.map((run) => [run.workflowSlug, run]));
    expect(Object.keys(bySlug).sort()).toEqual(['corner', 'feedback-triage']);
    expect(bySlug['feedback-triage']).toMatchObject({
      runId,
      roomId: CORNER,
      roomName: 'Issues triage',
      parentRoomId: ROOM,
      description: 'Daily feedback sweep',
      state: 'approve',
      status: 'live',
      holder: { id: TRIAGER, name: 'Candy', kind: 'agent' },
      // A gate is a choice card any person in the Room answers.
      viewerHolds: true,
      earlierRunCount: 0,
    });
    expect(bySlug.corner).toMatchObject({
      runId: CORNER,
      roomId: CORNER,
      state: 'implement',
      status: 'live',
      holder: { id: TRIAGER, name: 'Candy' },
      viewerHolds: false,
    });
    // The holder sees their own step as theirs.
    const asTriager = await phone.execute('listRoomWorkflowRuns', { roomId: CORNER }, TRIAGER);
    expect(asTriager.workflows.find((run) => run.workflowSlug === 'corner')!.viewerHolds).toBe(true);
  });

  it('counts earlier runs and prefers the live one', async () => {
    await saveWorkflow(database, await command(CORNER, TRIAGER), { contract: TRIAGE });
    const start = async () =>
      (
        await startWorkflow(database, await command(CORNER, TRIAGER), {
          name: 'feedback-triage',
          roleBindings: { triager: TRIAGER },
        })
      ).runId;
    const end = async (runId: string) =>
      handoff(database, await command(CORNER, TRIAGER), { runId, outcome: 'nothing_new', contents: {} });
    await end(await start());
    const live = await start();
    // A later run that already ended does not displace the live one.
    await end(await start());
    const listed = await phone.execute('listRoomWorkflowRuns', { roomId: ROOM }, OWNER);
    const triage = listed.workflows.find((run) => run.workflowSlug === 'feedback-triage')!;
    expect(triage).toMatchObject({ runId: live, status: 'live', state: 'pull', earlierRunCount: 1 });
  });

  it('refuses a viewer who cannot read the Room', async () => {
    await triageRun();
    await expect(
      phone.execute('listRoomWorkflowRuns', { roomId: ROOM }, OUTSIDER),
    ).rejects.toThrow('room access denied');
    await expect(
      phone.execute('readWorkflowRun', { roomId: CORNER, runId: 'x'.repeat(64) }, OUTSIDER),
    ).rejects.toThrow('room access denied');
    // A Room the outsider does read has no runs of this Room's.
    expect(
      (await phone.execute('listRoomWorkflowRuns', { roomId: OTHER_ROOM }, OUTSIDER)).workflows,
    ).toEqual([]);
  });
});

describe('readWorkflowRun', () => {
  it('returns the pinned contract and the ordered history of a run that looped', async () => {
    const runId = await triageRun();
    const detail = await phone.execute('readWorkflowRun', { roomId: CORNER, runId }, OWNER);
    expect(detail.contract).toEqual(TRIAGE);
    expect(detail.history.map(({ fromState, outcome, toState }) => ({ fromState, outcome, toState }))).toEqual([
      { fromState: undefined, outcome: undefined, toState: 'pull' },
      { fromState: 'pull', outcome: 'retry', toState: 'pull' },
      { fromState: 'pull', outcome: 'ranked', toState: 'approve' },
    ]);
    expect(detail.history[1]!.actor).toMatchObject({ id: TRIAGER, name: 'Candy' });
    expect(detail.history.every((step) => typeof step.at === 'number')).toBe(true);
    expect(detail.roleHolders).toEqual({ triager: { id: TRIAGER, name: 'Candy', kind: 'agent' } });
    expect(detail.run).toMatchObject({ runId, state: 'approve', status: 'live', earlierRunCount: 0 });
  });

  it("reads a corner's lifecycle run, resolving the live reviewer binding from the parent Room", async () => {
    await advanceCorner(database, CORNER, {
      kind: 'open',
      lane: 'code',
      workspaceId: WORKSPACE,
      implementerAgentId: TRIAGER,
    });
    const detail = await phone.execute('readWorkflowRun', { roomId: CORNER, runId: CORNER }, OWNER);
    expect(detail.contract.name).toBe('corner');
    expect(detail.history.map((step) => step.toState)).toEqual(['opened', 'implement']);
    expect(detail.history[1]).toMatchObject({ fromState: 'opened', outcome: 'code' });
    expect(detail.roleHolders).toMatchObject({
      implementer: { id: TRIAGER, name: 'Candy' },
      reviewer: { id: REVIEWER, name: 'Hoots' },
    });
  });

  it('refuses an unknown run', async () => {
    await expect(
      phone.execute('readWorkflowRun', { roomId: CORNER, runId: 'f'.repeat(64) }, OWNER),
    ).rejects.toThrow('workflow run not found');
  });
});
