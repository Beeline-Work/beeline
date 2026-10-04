import { DaemonService } from './daemon-service.js';
import { LiveHub } from './live.js';
import { describedWorkflow } from './test-support.js';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { createAgentCommand, claimAgentCommand, readAgentCommands, type CommandRow } from './agent-command.js';
import { advanceCorner, CORNER_LIFECYCLE_CONTRACT } from './corner-lifecycle.js';
import { PhoneService } from './phone-service.js';
import { answerRoomChoice, postRoomChoice } from './room-choice.js';
import { handoff, saveWorkflow, startWorkflow } from './workflow-runs.js';

/**
 * The phone's workflow run reads over real `workflow-handoff` cards written by
 * `startWorkflow`/`handoff`, and a corner's own lifecycle cards written by
 * `advanceCorner` — never hand-built rows.
 */

vi.mock('node:crypto', async (importOriginal) => {
  const crypto = await importOriginal<typeof import('node:crypto')>();
  return { ...crypto, randomBytes: vi.fn(crypto.randomBytes) };
});

const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const ROOM = '20000000-0000-4000-8000-000000000001';
const CORNER = '30000000-0000-4000-8000-000000000001';
const OTHER_ROOM = '40000000-0000-4000-8000-000000000001';
const OWNER = 'a'.repeat(64);
const TRIAGER = 'b'.repeat(64);
const REVIEWER = 'c'.repeat(64);
const OUTSIDER = 'e'.repeat(64);
const FIX_CORNER = '50000000-0000-4000-8000-000000000001';
const HIDDEN_CORNER = '50000000-0000-4000-8000-000000000002';
const UNLISTED_CORNER = '50000000-0000-4000-8000-000000000003';

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
  vi.mocked(randomBytes).mockReset();
  const crypto = await vi.importActual<typeof import('node:crypto')>('node:crypto');
  vi.mocked(randomBytes).mockImplementation(crypto.randomBytes);
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
  phone = new PhoneService(database, 'http://test');
});
afterEach(async () => database.close());

async function triageRun(): Promise<string> {
  await saveWorkflow(database, await command(CORNER, TRIAGER), { contract: describedWorkflow(TRIAGE)});
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

  it('keeps the last role holder after the run ends', async () => {
    await saveWorkflow(database, await command(CORNER, TRIAGER), { contract: describedWorkflow(TRIAGE)});
    const { runId } = await startWorkflow(database, await command(CORNER, TRIAGER), {
      name: 'feedback-triage',
      roleBindings: { triager: TRIAGER },
    });
    await handoff(database, await command(CORNER, TRIAGER), {
      runId,
      outcome: 'nothing_new',
      contents: {},
    });
    await advanceCorner(database, CORNER, {
      kind: 'open',
      lane: 'code',
      workspaceId: WORKSPACE,
      implementerAgentId: TRIAGER,
    });
    expect(
      (await advanceCorner(database, CORNER, { kind: 'closed' })).accepted,
    ).toBe(true);
    const listed = await phone.execute('listRoomWorkflowRuns', { roomId: ROOM }, OWNER);
    const bySlug = Object.fromEntries(listed.workflows.map((run) => [run.workflowSlug, run]));
    expect(bySlug['feedback-triage']).toMatchObject({
      runId,
      state: 'done',
      status: 'done',
      holder: { id: TRIAGER, name: 'Candy', kind: 'agent' },
      viewerHolds: false,
    });
    // Closing leaves `implement`, whose role is the implementer, not the system author of the card.
    expect(bySlug.corner).toMatchObject({
      state: 'closed',
      status: 'abandoned',
      holder: { id: TRIAGER, name: 'Candy', kind: 'agent' },
      viewerHolds: false,
    });
  });

  it('counts earlier runs and prefers the live one', async () => {
    await saveWorkflow(database, await command(CORNER, TRIAGER), { contract: describedWorkflow(TRIAGE)});
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
    await database.query(`UPDATE memberships SET role='admin' WHERE room_id=$1 AND identity_id=$2`, [CORNER, OWNER]);
    const later = await phone.execute('startOwnedWorkflow', {
      roomId: CORNER, name: 'feedback-triage', roleBindings: { triager: TRIAGER },
    }, OWNER);
    await end(later.runId);
    const listed = await phone.execute('listRoomWorkflowRuns', { roomId: ROOM }, OWNER);
    const triage = listed.workflows.find((run) => run.workflowSlug === 'feedback-triage')!;
    expect(triage).toMatchObject({ runId: live, status: 'live', state: 'pull', earlierRunCount: 1, activeRunIds: [live] });
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
  it('S05-1 lists the head and history in sequence for same-transaction descending IDs', async () => {
    const starter = await command(CORNER, TRIAGER);
    await saveWorkflow(database, starter, { contract: describedWorkflow(TRIAGE)});
    const runId = await database.transaction(async (tx) => {
      vi.mocked(randomBytes).mockImplementationOnce(() => Buffer.alloc(32, 0xff));
      const { runId } = await startWorkflow(tx, starter, {
        name: 'feedback-triage',
        roleBindings: { triager: TRIAGER },
      });
      vi.mocked(randomBytes).mockImplementationOnce(() => Buffer.alloc(32, 0));
      await handoff(tx, starter, { runId, outcome: 'ranked', contents: {} });
      expect(
        (
          await tx.query<{ count: string }>(
            `SELECT count(DISTINCT created_at)::text count FROM messages
         WHERE card->>'runId'=$1 AND card_type='workflow-handoff'`,
            [runId],
          )
        ).rows[0]!.count,
      ).toBe('1');
      return runId;
    });
    const detail = await phone.execute('readWorkflowRun', { roomId: CORNER, runId }, OWNER);
    expect({ head: detail.run.state, history: detail.history.map((step) => step.toState) }).toEqual(
      { head: 'approve', history: ['pull', 'approve'] },
    );
    const listed = await phone.execute('listRoomWorkflowRuns', { roomId: ROOM }, OWNER);
    expect(listed.workflows.find((run) => run.runId === runId)?.state).toBe('approve');
  });

  it('returns the pinned contract and the ordered history of a run that looped', async () => {
    const runId = await triageRun();
    const detail = await phone.execute('readWorkflowRun', { roomId: CORNER, runId }, OWNER);
    expect(detail.contract).toEqual(describedWorkflow(TRIAGE));
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

  it('renders a corner run from the in-code contract whatever name and version older cards carry, with no stored corner row', async () => {
    expect(
      (await database.query(`SELECT 1 FROM workspace_skills WHERE slug='corner'`)).rowCount,
    ).toBe(0);
    await advanceCorner(database, CORNER, {
      kind: 'open',
      lane: 'code',
      workspaceId: WORKSPACE,
      implementerAgentId: TRIAGER,
    });
    // Cards written while a stored copy existed name it and its version.
    await database.query(
      `UPDATE messages SET card=card || '{"workflowSlug":"corner","workflowVersion":7}'::jsonb
       WHERE room_id=$1`,
      [CORNER],
    );
    const detail = await phone.execute('readWorkflowRun', { roomId: CORNER, runId: CORNER }, OWNER);
    expect(detail.contract).toEqual(CORNER_LIFECYCLE_CONTRACT);
    expect(detail.history.map((step) => step.toState)).toEqual(['opened', 'implement']);
    const listed = await phone.execute('listRoomWorkflowRuns', { roomId: ROOM }, OWNER);
    expect(listed.workflows).toEqual([
      expect.objectContaining({
        runId: CORNER,
        workflowSlug: 'corner',
        description: CORNER_LIFECYCLE_CONTRACT.description,
        state: 'implement',
        status: 'live',
      }),
    ]);
  });

  it('keeps a Workspace workflow saved as corner apart from the corner lifecycle', async () => {
    const saved = {
      ...TRIAGE,
      name: 'corner',
      description: 'A workflow someone named corner',
    };
    await saveWorkflow(database, await command(ROOM, TRIAGER), { contract: describedWorkflow(saved)});
    await saveWorkflow(database, await command(ROOM, TRIAGER), {
      contract: describedWorkflow({ ...saved, description: 'A workflow someone named corner, again' }),
    });
    const { runId } = await startWorkflow(database, await command(ROOM, TRIAGER), {
      name: 'corner',
      roleBindings: { triager: TRIAGER },
    });
    await advanceCorner(database, CORNER, {
      kind: 'open',
      lane: 'code',
      workspaceId: WORKSPACE,
      implementerAgentId: TRIAGER,
    });
    const lifecycleCards = await database.query<{ slug: string | null; version: string | null }>(
      `SELECT card->>'workflowSlug' slug,card->>'workflowVersion' version FROM messages
       WHERE room_id=$1 AND card_type='corner-workflow-handoff'`,
      [CORNER],
    );
    expect(lifecycleCards.rows).toEqual([
      { slug: null, version: null },
      { slug: null, version: null },
    ]);

    const listed = await phone.execute('listRoomWorkflowRuns', { roomId: ROOM }, OWNER);
    const byRun = Object.fromEntries(listed.workflows.map((run) => [run.runId, run]));
    expect(Object.keys(byRun).sort()).toEqual([CORNER, runId].sort());
    expect(byRun[CORNER]).toMatchObject({
      workflowSlug: 'corner',
      description: CORNER_LIFECYCLE_CONTRACT.description,
      state: 'implement',
      earlierRunCount: 0,
      activeRunIds: [CORNER],
    });
    expect(byRun[CORNER]).not.toHaveProperty('ownership');
    expect(byRun[runId]).toMatchObject({
      workflowSlug: 'corner',
      description: 'A workflow someone named corner, again',
      state: 'pull',
      earlierRunCount: 0,
      activeRunIds: [runId],
    });

    const corner = await phone.execute('readWorkflowRun', { roomId: CORNER, runId: CORNER }, OWNER);
    expect(corner.contract).toEqual(CORNER_LIFECYCLE_CONTRACT);
    expect(corner.run.activeRunIds).toEqual([CORNER]);
    const definition = await phone.execute('readWorkflowDefinition', { roomId: ROOM, name: 'corner' }, OWNER);
    expect(definition.runs.map((run) => run.runId)).toEqual([runId]);
    const ordinary = await phone.execute('readWorkflowRun', { roomId: ROOM, runId }, OWNER);
    expect(ordinary.contract.description).toBe('A workflow someone named corner, again');
    expect(ordinary.history.map((step) => step.toState)).toEqual(['pull']);
  });

  it('lists no corner on a step whose handoff names none, even one its holder opened meanwhile', async () => {
    await advanceCorner(database, CORNER, {
      kind: 'open',
      lane: 'code',
      workspaceId: WORKSPACE,
      implementerAgentId: TRIAGER,
    });
    await database.query(
      `INSERT INTO rooms(id,workspace_id,created_by,name,parent_id) VALUES($1,$2,$3,'Unrelated corner',$4)`,
      [UNLISTED_CORNER, WORKSPACE, TRIAGER, ROOM],
    );
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
      [WORKSPACE, UNLISTED_CORNER, OWNER],
    );
    const detail = await phone.execute('readWorkflowRun', { roomId: CORNER, runId: CORNER }, OWNER);
    expect(detail.history.map((step) => [step.toState, step.openedCorners ?? null])).toEqual([
      ['opened', null],
      ['implement', null],
    ]);
  });

  it("returns each step's contents, the gate's recorded answer, and the corners the dispatch opened", async () => {
    await saveWorkflow(database, await command(CORNER, TRIAGER), { contract: describedWorkflow(TRIAGE)});
    const { runId } = await startWorkflow(database, await command(CORNER, TRIAGER), {
      name: 'feedback-triage',
      roleBindings: { triager: TRIAGER },
    });
    const problems = [{ description: 'Corner dropdown vanishes', reports: 3, items: ['f1'] }];
    await handoff(database, await command(CORNER, TRIAGER), {
      runId,
      outcome: 'ranked',
      contents: { problems },
    });
    const waiting = await phone.execute('readWorkflowRun', { roomId: CORNER, runId }, OWNER);
    expect(waiting.history[1]).toMatchObject({ toState: 'approve', contents: { problems } });
    expect(waiting.history[1]!.gate).toEqual({
      question: 'feedback-triage: approve',
      options: [
        { letter: 'A', label: 'dispatch', consequence: 'go to dispatch' },
        { letter: 'B', label: 'skip', consequence: 'go to done' },
      ],
      status: 'open',
    });

    const choice = (
      await database.query<{ id: string; options: Array<{ optionId: string; label: string }> }>(
        `SELECT id,options FROM room_choices WHERE room_id=$1 AND status='open'`,
        [CORNER],
      )
    ).rows[0]!;
    await answerRoomChoice(database, {
      choiceId: choice.id,
      optionId: choice.options.find((option) => option.label === 'dispatch')!.optionId,
      viewerId: OWNER,
    });
    await handoff(database, await command(CORNER, TRIAGER), {
      runId,
      outcome: 'dispatch',
      contents: {},
    });
    // The triager opens two fix corners in the top Room; the owner is only in
    // one. It also opens an unrelated corner the handoff does not list.
    await database.query(
      `INSERT INTO rooms(id,workspace_id,created_by,name,parent_id) VALUES
         ($1,$4,$5,'Corner dropdown fix',$6),($2,$4,$5,'Private fix',$6),($3,$4,$5,'Unrelated corner',$6)`,
      [FIX_CORNER, HIDDEN_CORNER, UNLISTED_CORNER, WORKSPACE, TRIAGER, ROOM],
    );
    for (const roomId of [FIX_CORNER, UNLISTED_CORNER])
      for (const who of [OWNER, TRIAGER])
        await database.query(
          `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,
          [WORKSPACE, roomId, who],
        );
    await database.query(
      `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'owner')`,
      [WORKSPACE, HIDDEN_CORNER, TRIAGER],
    );
    const corners = [
      { cornerId: FIX_CORNER, name: 'Corner dropdown fix', items: ['f1'] },
      { cornerId: HIDDEN_CORNER, name: 'Private fix', items: ['f2'] },
    ];
    await handoff(database, await command(CORNER, TRIAGER), {
      runId,
      outcome: 'dispatched',
      contents: { corners },
    });

    const detail = await phone.execute('readWorkflowRun', { roomId: CORNER, runId }, OWNER);
    expect(detail.history.map((step) => step.toState)).toEqual(['pull', 'approve', 'dispatch', 'done']);
    expect(detail.history[1]!.gate).toMatchObject({
      status: 'answered',
      answer: 'dispatch',
      answeredBy: { id: OWNER, name: 'Owner', kind: 'human' },
      answeredAt: expect.any(Number),
    });
    expect(detail.history[2]).toMatchObject({ fromState: 'approve', outcome: 'dispatch' });
    // Only a listed corner the viewer can read, on the step that opened it.
    expect(detail.history[2]!.openedCorners).toEqual([
      { id: FIX_CORNER, name: 'Corner dropdown fix', parentRoomId: ROOM },
    ]);
    expect(detail.history[3]).toMatchObject({
      fromState: 'dispatch',
      contents: { corners },
    });
    expect(detail.history.filter((step) => step.openedCorners)).toHaveLength(1);
    // The triager, a member of both, sees both listed corners and not the unrelated one.
    const asTriager = await phone.execute('readWorkflowRun', { roomId: CORNER, runId }, TRIAGER);
    expect(asTriager.history[2]!.openedCorners!.map((corner) => corner.id)).toEqual([
      FIX_CORNER,
      HIDDEN_CORNER,
    ]);
  });

  it('carries handle, picture and face for each actor, the human who answered the gate, and the viewer', async () => {
    await database.query(
      `UPDATE identities SET handle=CASE id WHEN $1 THEN '@lunch@beeline.test' ELSE 'candy' END,
         face_id=CASE id WHEN $1 THEN 'owl' ELSE 'fox' END,
         avatar=CASE id WHEN $2 THEN '/v1/agent-avatars/candy.png' END
       WHERE id IN ($1,$2)`,
      [OWNER, TRIAGER],
    );
    await saveWorkflow(database, await command(CORNER, TRIAGER), { contract: describedWorkflow(TRIAGE)});
    const { runId } = await startWorkflow(database, await command(CORNER, TRIAGER), {
      name: 'feedback-triage',
      roleBindings: { triager: TRIAGER },
    });
    await handoff(database, await command(CORNER, TRIAGER), { runId, outcome: 'ranked', contents: {} });
    const owner = { id: OWNER, name: 'Owner', kind: 'human', handle: '@lunch@beeline.test', face: 'owl' };
    const candy = {
      id: TRIAGER,
      name: 'Candy',
      kind: 'agent',
      handle: 'candy',
      face: 'fox',
      avatar: 'http://test/v1/agent-avatars/candy.png',
    };
    // The gate waits on the viewer: the payload names them so the row can draw their own mark.
    const waiting = await phone.execute('readWorkflowRun', { roomId: CORNER, runId }, OWNER);
    expect(waiting.viewer).toEqual(owner);
    expect(waiting.run).toMatchObject({ viewerHolds: true, holder: candy });
    expect(waiting.roleHolders).toEqual({ triager: candy });
    expect(waiting.history[1]!.actor).toEqual(candy);
    const choice = (
      await database.query<{ id: string; option_id: string }>(
        `SELECT id::text id,options->0->>'optionId' option_id FROM room_choices WHERE room_id=$1`,
        [CORNER],
      )
    ).rows[0]!;
    await answerRoomChoice(database, { choiceId: choice.id, viewerId: OWNER, optionId: choice.option_id });
    const answered = await phone.execute('readWorkflowRun', { roomId: CORNER, runId }, TRIAGER);
    expect(answered.history[1]!.gate!.answeredBy).toEqual(owner);
    expect(answered.viewer).toEqual(candy);
  });

  it('refuses an unknown run', async () => {
    await expect(
      phone.execute('readWorkflowRun', { roomId: CORNER, runId: 'f'.repeat(64) }, OWNER),
    ).rejects.toThrow('workflow run not found');
  });
});


describe('optional workflow receipts end to end', () => {
  it('stores a summary, sends the hint to the dispatched agent, and reads receipts through the phone', async () => {
    const contract = { ...TRIAGE, summary: 'Gather issues, request approval, and dispatch fixes.', handoffs: {
      ...TRIAGE.handoffs, pull: { ...TRIAGE.handoffs.pull, hint: 'the ranked issues' },
      approve: { ...TRIAGE.handoffs.approve, hint: 'the human decision' },
    } };
    await saveWorkflow(database, await command(CORNER, TRIAGER), { contract: describedWorkflow(contract) });
    const { runId } = await startWorkflow(database, await command(CORNER, TRIAGER), {
      name: contract.name, roleBindings: { triager: TRIAGER },
    });
    const inbox = await readAgentCommands(database, CORNER, TRIAGER);
    expect(inbox.commands.some((entry) => entry.source.body.includes('Receipt hint for this state: the ranked issues'))).toBe(true);
    const receipt = { line: 'Ranked two issues.', refs: [
      { kind: 'file' as const, label: 'Issue list', url: 'https://beeline.test/issues.txt' },
    ] };
    await handoff(database, await command(CORNER, TRIAGER), { runId, outcome: 'retry', contents: {}, receipt });
    await handoff(database, await command(CORNER, TRIAGER), { runId, outcome: 'ranked', contents: {}, receipt: {} });
    const detail = await phone.execute('readWorkflowRun', { roomId: CORNER, runId }, OWNER);
    expect(detail.contract.summary).toBe(contract.summary);
    expect(detail.history[1]?.receipt).toEqual({ ...receipt, exit: { gate: 'retry', actorId: TRIAGER } });
    expect(detail.history[2]?.receipt).toEqual({ exit: { gate: 'ranked', actorId: TRIAGER } });
    const choice = (await database.query<{ id: string; option_id: string }>(
      `SELECT id::text id,options->0->>'optionId' option_id FROM room_choices WHERE room_id=$1`, [CORNER],
    )).rows[0]!;
    await answerRoomChoice(database, { choiceId: choice.id, viewerId: OWNER, optionId: choice.option_id });
    const answered = await readAgentCommands(database, CORNER, TRIAGER);
    expect(answered.commands.some((entry) => entry.source.body.includes('Receipt hint for this state: the human decision'))).toBe(true);
    // Missing is equally optional: no outcome text or refs are invented.
    await handoff(database, await command(CORNER, TRIAGER), { runId, outcome: 'skip', contents: {} });
    const ended = await phone.execute('readWorkflowRun', { roomId: CORNER, runId }, OWNER);
    expect(ended.history[3]?.receipt).toEqual({ exit: { gate: 'skip', actorId: TRIAGER } });
  });

  it('rejects invalid receipts without advancing the run', async () => {
    const runId = await triageRun();
    const worker = await command(CORNER, TRIAGER);
    for (const receipt of [{ line: 'x'.repeat(141) }, { refs: Array(4).fill({ kind: 'url', label: 'link', url: 'https://beeline.test' }) }])
      await expect(handoff(database, worker, { runId, outcome: 'skip', contents: {}, receipt })).rejects.toThrow(/receipt/);
    const detail = await phone.execute('readWorkflowRun', { roomId: CORNER, runId }, OWNER);
    expect(detail.run.state).toBe('approve');
  });
});

describe('a workflow gate answer with a note', () => {
  async function openGate(): Promise<{ runId: string; choiceId: string; dispatch: string }> {
    const runId = await triageRun();
    const choice = (
      await database.query<{ id: string; options: Array<{ optionId: string; label: string }> }>(
        `SELECT id,options FROM room_choices WHERE room_id=$1 AND status='open'`,
        [CORNER],
      )
    ).rows[0]!;
    const dispatch = choice.options.find((option) => option.label === 'dispatch')!.optionId;
    return { runId, choiceId: choice.id, dispatch };
  }

  it('stores the note, wakes the gate agent with it, and shows it on the run', async () => {
    const { runId, choiceId, dispatch } = await openGate();
    await phone.execute(
      'answerChoice',
      { choiceId, optionId: dispatch, note: '  only the dropdown one,\n skip the rest  ' },
      OWNER,
    );
    const stored = await database.query<{ note: string | null }>(
      `SELECT note FROM room_choice_votes WHERE choice_id=$1`,
      [choiceId],
    );
    expect(stored.rows).toEqual([{ note: 'only the dropdown one, skip the rest' }]);
    const inbox = await readAgentCommands(database, CORNER, TRIAGER);
    const woken = inbox.commands.find((c) => c.source.systemEvent?.kind === 'choice-answered');
    expect(woken?.source.body).toContain(
      'Their note with the answer: "only the dropdown one, skip the rest"',
    );
    const detail = await phone.execute('readWorkflowRun', { roomId: CORNER, runId }, OWNER);
    expect(detail.history[2]!.gate).toMatchObject({
      status: 'answered',
      answer: 'dispatch',
      answeredBy: { id: OWNER, name: 'Owner', kind: 'human' },
      note: 'only the dropdown one, skip the rest',
    });
  });

  it('answers exactly as before without a note, and treats a blank note as none', async () => {
    const { runId, choiceId, dispatch } = await openGate();
    await phone.execute('answerChoice', { choiceId, optionId: dispatch, note: '   ' }, OWNER);
    const inbox = await readAgentCommands(database, CORNER, TRIAGER);
    const woken = inbox.commands.find((c) => c.source.systemEvent?.kind === 'choice-answered');
    expect(woken?.source.body).not.toContain('note');
    const detail = await phone.execute('readWorkflowRun', { roomId: CORNER, runId }, OWNER);
    expect(detail.history[2]!.gate).toMatchObject({ status: 'answered', answer: 'dispatch' });
    expect(detail.history[2]!.gate).not.toHaveProperty('note');
  });

  it('refuses a note from someone who may not answer the gate, and leaves it open', async () => {
    const { runId, choiceId, dispatch } = await openGate();
    await expect(
      phone.execute('answerChoice', { choiceId, optionId: dispatch, note: 'sneaky' }, OUTSIDER),
    ).rejects.toThrow('room access denied');
    const votes = await database.query(`SELECT 1 FROM room_choice_votes WHERE choice_id=$1`, [
      choiceId,
    ]);
    expect(votes.rows).toHaveLength(0);
    const detail = await phone.execute('readWorkflowRun', { roomId: CORNER, runId }, OWNER);
    expect(detail.history[2]!.gate).toMatchObject({ status: 'open' });
    expect(detail.history[2]!.gate).not.toHaveProperty('note');
  });

  it('refuses an over-long note and a note on an ordinary choice card', async () => {
    const { choiceId, dispatch } = await openGate();
    await expect(
      phone.execute('answerChoice', { choiceId, optionId: dispatch, note: 'x'.repeat(141) }, OWNER),
    ).rejects.toThrow('choice note is too long');
    const plain = await postRoomChoice(database, {
      roomId: ROOM,
      agentId: REVIEWER,
      mode: 'question',
      prompt: 'Ship it?',
      options: [
        { label: 'yes', consequence: 'ship' },
        { label: 'no', consequence: 'hold' },
      ],
    });
    await expect(
      phone.execute('answerChoice', { choiceId: plain.choiceId, optionId: 'A', note: 'hi' }, OWNER),
    ).rejects.toThrow('choice note is only accepted on a workflow gate');
  });
});

describe('visit output through daemon completion and phone GET', () => {
  async function start(roomId = CORNER, starter = TRIAGER) {
    await saveWorkflow(database, await command(roomId, TRIAGER), { contract: describedWorkflow(TRIAGE) });
    return (await startWorkflow(database, await command(roomId, starter), {
      name: TRIAGE.name, roleBindings: { triager: TRIAGER },
    })).runId;
  }
  async function wake(runId: string, roomId = CORNER) {
    const pending = (await database.query<CommandRow>(
      `SELECT command.* FROM agent_commands command JOIN messages source ON source.id=command.source_message_id
       WHERE command.room_id=$1 AND command.agent_id=$2 AND command.state='pending'
         AND source.card->>'runId'=$3 ORDER BY command.created_at DESC LIMIT 1`,
      [roomId, TRIAGER, runId],
    )).rows[0]!;
    expect(pending).toBeDefined();
    return claimAgentCommand(database, roomId, TRIAGER, pending.id, `generation-${pending.id}`);
  }
  async function final(command: CommandRow, text: string) {
    return new DaemonService(database, new LiveHub()).execute('postRoomMessage', {
      roomId: command.room_id, requestId: command.turn_request_id,
      generationId: command.generation_id!, text,
    }, TRIAGER);
  }
  const read = (runId: string, viewer = OWNER, roomId = CORNER) =>
    phone.execute('readWorkflowRun', { roomId, runId }, viewer);

  it('Reproduction wf-human-1: isolates two runs and repeated visits, including late final and duplicate delivery', async () => {
    const one = await start();
    const two = await start(CORNER, REVIEWER);
    const first = await wake(one);
    const second = await wake(two);
    const daemon = new DaemonService(database, new LiveHub());
    await daemon.execute('postAgentDraft', { roomId: CORNER, turnId: first.turn_request_id,
      requestId: first.turn_request_id, generationId: first.generation_id!,
      text: 'Older chunk. Newest chunk.', latestChunk: 'Newest chunk.' }, TRIAGER);
    expect((await read(one)).history[0]).toMatchObject({ liveOutput: 'Newest chunk.',
      outputTurns: [`${TRIAGER}:${first.turn_request_id}`] });
    expect((await read(two)).history[0]!.liveOutput).toBeUndefined();
    await handoff(database, first, { runId: one, outcome: 'retry', contents: {} });
    const repeated = await wake(one);
    // The old turn closes after the next visit is already held by the same agent.
    const saved = await final(first, 'First visit final.');
    await final(first, 'First visit final.');
    await final(second, 'Other run final.');
    await handoff(database, repeated, { runId: one, outcome: 'nothing_new', contents: {} });
    await final(repeated, 'Second visit final.');
    for (const viewer of [OWNER, REVIEWER]) {
      const fresh = await read(one, viewer);
      expect(fresh.history.map((step) => step.toState)).toEqual(['pull', 'pull', 'done']);
      expect(fresh.history[0]!.finalReply).toEqual({ messageId: saved.id, text: 'First visit final.' });
      expect(fresh.history[1]!.finalReply?.text).toBe('Second visit final.');
      expect(fresh.history[2]!.finalReply).toBeUndefined();
      expect(fresh.contract.summary).toBe('Daily feedback sweep');
      expect(fresh.contract.handoffs.pull!.does).toBe('Perform pull.');
    }
    expect((await read(two)).history[0]!.finalReply?.text).toBe('Other run final.');
    await expect(read(one, OUTSIDER)).rejects.toThrow();
  });

  it('captures a committed reply before handoff and retains pinned metadata across revisions', async () => {
    const runId = await start();
    const held = await wake(runId);
    await final(held, 'Reply before handoff.');
    await handoff(database, await command(CORNER, TRIAGER), { runId, outcome: 'nothing_new', contents: {} });
    await saveWorkflow(database, await command(CORNER, TRIAGER), { contract: {
      ...(describedWorkflow(TRIAGE) as object), summary: 'A revised overview.',
    } });
    const fresh = await read(runId);
    expect(fresh.history[0]!.finalReply?.text).toBe('Reply before handoff.');
    expect(fresh.contract.summary).toBe('Daily feedback sweep');
  });

  it('stores the newest chunk in a top-level workflow without showing unrelated Room drafts', async () => {
    const runId = await start(ROOM);
    const held = await wake(runId, ROOM);
    const daemon = new DaemonService(database, new LiveHub());
    await daemon.execute('postAgentDraft', { roomId: ROOM, turnId: held.turn_request_id,
      requestId: held.turn_request_id, generationId: held.generation_id!,
      text: 'Accumulated text', latestChunk: 'Latest delta' }, TRIAGER);
    expect((await read(runId, OWNER, ROOM)).history[0]!.liveOutput).toBe('Latest delta');
    expect((await read(runId, REVIEWER, ROOM)).history[0]!.liveOutput).toBe('Latest delta');
  });

  it('does not turn failed or cancelled output into a final; a reclaimed turn keeps its original visit', async () => {
    const runId = await start();
    const held = await wake(runId);
    await handoff(database, held, { runId, outcome: 'retry', contents: {} });
    await database.query(`UPDATE agent_commands SET state='pending',generation_id=NULL WHERE id=$1`, [held.id]);
    await expect(final(held, 'Refused stale final')).rejects.toThrow();
    const retried = await claimAgentCommand(database, CORNER, TRIAGER, held.id, 'retry-generation');
    await final(retried, 'Recovered final.');
    expect((await read(runId)).history[0]!.finalReply?.text).toBe('Recovered final.');
    expect((await read(runId)).history[1]!.finalReply).toBeUndefined();
    const current = await wake(runId);
    await database.query(`UPDATE agent_turns SET status='cancelled' WHERE room_id=$1 AND request_id=$2`, [CORNER, current.turn_request_id]);
    await expect(final(current, 'Cancelled final')).rejects.toThrow();
    expect((await read(runId)).history[1]!.finalReply).toBeUndefined();
  });

  it('pins a resumed turn to its parent visit after the run has advanced', async () => {
    const runId = await start();
    const held = await wake(runId);
    await handoff(database, held, { runId, outcome: 'retry', contents: {} });
    const source = await command(CORNER, TRIAGER);
    const resumed = (await createAgentCommand(database, { roomId: CORNER, agentId: TRIAGER,
      sourceMessageId: source.source_message_id, action: 'resume', reason: 'resume',
      parent: held, retainDepth: true, turnRequestId: held.turn_request_id }))!;
    await database.query(`UPDATE agent_commands SET state='complete' WHERE id=$1`, [held.id]);
    const claimed = await claimAgentCommand(database, CORNER, TRIAGER, resumed.id, 'resume-generation');
    await final(claimed, 'Final after resuming the original turn.');
    const fresh = await read(runId);
    expect(fresh.history[0]!.finalReply?.text).toBe('Final after resuming the original turn.');
    expect(fresh.history[1]!.finalReply).toBeUndefined();
  });

  it('keeps legacy revisions executable without inventing descriptions or replies', async () => {
    const runId = await start();
    await database.query(`UPDATE workspace_skill_versions SET markdown=$1
      WHERE skill_id=(SELECT id FROM workspace_skills WHERE workspace_id=$2 AND slug=$3)`,
      [JSON.stringify(TRIAGE), WORKSPACE, TRIAGE.name]);
    const legacy = await read(runId);
    expect(legacy.contract.summary).toBeUndefined();
    expect(legacy.contract.handoffs.pull!.does).toBeUndefined();
    expect(legacy.history[0]!.finalReply).toBeUndefined();
    await handoff(database, await command(CORNER, TRIAGER), { runId, outcome: 'nothing_new', contents: {} });
    expect((await read(runId)).run.status).toBe('done');
  });
});
