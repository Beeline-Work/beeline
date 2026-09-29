import { describe, expect, it } from 'vitest';
import { migrate } from './database.js';
import { PgliteDatabase } from './test-support.js';
import { createAgentCommand } from './agent-command.js';
import {
  completeWorkflowStep,
  listWorkflowRuns,
  putWorkflowDefinition,
  readWorkflowRun,
  startWorkflowRun,
  signalWorkflowEvent,
  runDueWorkflowDeadlines,
  runDueWorkflowSchedules,
  settleWorkflowGateChoice,
  listWorkflows,
  readWorkflow,
  publishWorkflow,
  settleWorkflowPublicationChoice,
  settleWorkflowStartChoice,
  checkWorkflow,
} from './workflow-service.js';
import { answerRoomChoice } from './room-choice.js';
import { PhoneService } from './phone-service.js';

const OWNER = 'a'.repeat(64);
const AUTHOR = 'b'.repeat(64);
const REVIEWER = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const OTHER_ROOM = '33333333-3333-4333-8333-333333333333';
const SOURCE = 'd'.repeat(64);

const definition = {
  version: 1,
  name: 'review-demo',
  success: ['done'],
  roles: ['author', 'reviewer'],
  trigger: { kind: 'manual' },
  start: 'write',
  states: {
    write: {
      kind: 'step',
      step: {
        role: 'author',
        skill: 'write-change',
        output: { head: 'string' },
        timeoutSeconds: 60,
        retries: 1,
      },
      on: { success: 'review', failure: 'stopped', timeout: 'stopped' },
    },
    review: {
      kind: 'step',
      step: {
        role: 'reviewer',
        skill: 'review-change',
        output: { verdict: 'string' },
        timeoutSeconds: 60,
        retries: 1,
      },
      on: { success: 'done', failure: 'stopped', timeout: 'stopped' },
    },
    stopped: { kind: 'terminal' },
    done: { kind: 'terminal' },
  },
};

async function fixture() {
  const db = new PgliteDatabase();
  await migrate(db);
  await db.query(
    `INSERT INTO identities(id,kind,name) VALUES ($1,'human','Owner'),($2,'agent','Author'),($3,'agent','Reviewer')`,
    [OWNER, AUTHOR, REVIEWER],
  );
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Workspace')`, [WORKSPACE]);
  await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Room')`, [
    ROOM,
    WORKSPACE,
    OWNER,
  ]);
  await db.query(`INSERT INTO rooms(id,workspace_id,created_by,name) VALUES($1,$2,$3,'Other Room')`, [
    OTHER_ROOM, WORKSPACE, OWNER,
  ]);
  for (const [index, slug] of ['write-change', 'review-change', 'author-skill', 'reviewer-skill'].entries()) {
    await db.query(
      `INSERT INTO workspace_skills(id,workspace_id,slug,description,current_version,revision,
         source_room_id,repository,target_commit)
       VALUES($1,$2,$3,'Workflow test skill',1,1,$4,'acme/repo',$5)`,
      [`${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
        WORKSPACE, slug, ROOM, 'a'.repeat(40)],
    );
  }
  await db.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES ($1,$2,$3,'owner'),($1,$2,$4,'member'),($1,$2,$5,'member')`,
    [WORKSPACE, ROOM, OWNER, AUTHOR, REVIEWER],
  );
  await db.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES ($1,$2,$3,'owner'),($1,$2,$4,'member'),($1,$2,$5,'member')`,
    [WORKSPACE, OTHER_ROOM, OWNER, AUTHOR, REVIEWER],
  );
  await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Start')`, [
    SOURCE,
    ROOM,
    OWNER,
  ]);
  const parent = await createAgentCommand(db, {
    roomId: ROOM,
    agentId: AUTHOR,
    sourceMessageId: SOURCE,
    reason: 'human_mention',
  });
  if (!parent) throw new Error('fixture command missing');
  return { db, parent };
}

describe('workflow run handoff', () => {
  it('reports an unknown workspace skill before a draft is saved', async () => {
    const { db, parent } = await fixture();
    try {
      const unknown = { ...definition, states: { ...definition.states,
        write: { ...definition.states.write, step: { ...definition.states.write.step,
          skill: 'not-installed' } } } };
      expect((await checkWorkflow(db, ROOM, unknown)).errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ rule: 'skill', state: 'write' })]),
      );
      await expect(db.transaction((tx) => putWorkflowDefinition(tx, ROOM, AUTHOR,
        unknown, undefined, parent))).rejects.toThrow('unknown workspace skill');
    } finally { await db.close(); }
  });
  it('publishes a pinned draft after human approval and lists it in another Room', async () => {
    const { db, parent } = await fixture();
    try {
      await db.transaction((tx) => putWorkflowDefinition(tx, ROOM, AUTHOR, definition, undefined, parent));
      const pending = await db.transaction((tx) => publishWorkflow(tx, ROOM, 'review-demo', parent));
      expect((await listWorkflows(db, OTHER_ROOM)).some((item) => item.name === 'review-demo')).toBe(false);
      await db.transaction(async (tx) => {
        await answerRoomChoice(tx, { choiceId: pending.choiceId, optionId: 'A', viewerId: OWNER });
        await settleWorkflowPublicationChoice(tx, pending.choiceId, 'A', OWNER);
      });
      expect((await listWorkflows(db, OTHER_ROOM)).find((item) => item.name === 'review-demo'))
        .toMatchObject({ layer: 'workspace', version: 1 });
      expect((await readWorkflow(db, OTHER_ROOM, 'review-demo')).definition).toEqual(definition);
      const otherSource = 'e'.repeat(64);
      await db.query(`INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,'Run it')`,
        [otherSource, OTHER_ROOM, OWNER]);
      const otherParent = await createAgentCommand(db, { roomId: OTHER_ROOM,
        agentId: AUTHOR, sourceMessageId: otherSource, reason: 'human_mention' });
      expect(otherParent).toBeTruthy();
      const run = await db.transaction((tx) => startWorkflowRun(tx, OTHER_ROOM, 'review-demo',
        { author: AUTHOR, reviewer: REVIEWER }, otherParent!));
      expect(run).toMatchObject({ layer: 'workspace', status: 'running' });
    } finally { await db.close(); }
  });

  it('starts a short draft immediately and waits for approval on a long draft', async () => {
    const { db, parent } = await fixture();
    try {
      await db.transaction((tx) => putWorkflowDefinition(tx, ROOM, AUTHOR, definition, undefined, parent));
      const short = await db.transaction((tx) => startWorkflowRun(tx, ROOM, 'review-demo',
        { author: AUTHOR, reviewer: REVIEWER }, parent));
      expect(short.status).toBe('running');
      const long = { ...definition, name: 'long-review',
        states: { ...definition.states, write: { ...definition.states.write,
          step: { ...definition.states.write.step, timeoutSeconds: 1801 } } } };
      await db.transaction((tx) => putWorkflowDefinition(tx, ROOM, AUTHOR, long, undefined, parent));
      const waiting = await db.transaction((tx) => startWorkflowRun(tx, ROOM, 'long-review',
        { author: AUTHOR, reviewer: REVIEWER }, parent));
      expect(waiting.status).toBe('waiting');
      const choice = (await db.query<{ choice_id: string }>(
        `SELECT choice_id FROM workflow_start_choices WHERE run_id=$1`, [waiting.runId],
      )).rows[0]!;
      await db.transaction(async (tx) => {
        await answerRoomChoice(tx, { choiceId: choice.choice_id, optionId: 'A', viewerId: OWNER });
        await settleWorkflowStartChoice(tx, choice.choice_id, 'A', OWNER);
      });
      expect((await readWorkflowRun(db, ROOM, waiting.runId)).run.status).toBe('running');
      const external = { ...definition, name: 'external-write-demo', states: {
        ...definition.states, write: { ...definition.states.write,
          step: { ...definition.states.write.step, effects: ['external-write'] } },
      } };
      await db.transaction((tx) => putWorkflowDefinition(tx, ROOM, AUTHOR, external, undefined, parent));
      const sideEffectRun = await db.transaction((tx) => startWorkflowRun(tx, ROOM,
        'external-write-demo', { author: AUTHOR, reviewer: REVIEWER }, parent));
      expect(sideEffectRun.status).toBe('waiting');
    } finally { await db.close(); }
  });

  it('fails a run when its agent-turn budget is exhausted', async () => {
    const { db, parent } = await fixture();
    try {
      await db.transaction((tx) => putWorkflowDefinition(tx, ROOM, AUTHOR, definition, undefined, parent));
      const run = await db.transaction((tx) => startWorkflowRun(tx, ROOM, 'review-demo',
        { author: AUTHOR, reviewer: REVIEWER }, parent));
      await db.query(`UPDATE workflow_runs SET turns_used=100 WHERE id=$1`, [run.runId]);
      const commandId = (await db.query<{ command_id: string }>(
        `SELECT command_id FROM workflow_run_assignments WHERE run_id=$1`, [run.runId],
      )).rows[0]!.command_id;
      const command = (await db.query<typeof parent>(
        `SELECT * FROM agent_commands WHERE id=$1`, [commandId],
      )).rows[0]!;
      const result = await db.transaction((tx) => completeWorkflowStep(tx, ROOM, run.runId, 0,
        { head: 'abc' }, 'success', command));
      expect(result).toMatchObject({ status: 'failed', error: 'workflow run agent-turn cap reached' });
    } finally { await db.close(); }
  });

  it('logs the human actor for reassign, jump, and kill', async () => {
    const { db, parent } = await fixture();
    try {
      const phone = new PhoneService(db, 'http://test');
      await db.transaction((tx) => putWorkflowDefinition(tx, ROOM, AUTHOR, definition, undefined, parent));
      const run = await db.transaction((tx) => startWorkflowRun(tx, ROOM, 'review-demo',
        { author: AUTHOR, reviewer: REVIEWER }, parent));
      await phone.execute('overrideWorkflowRun', { roomId: ROOM, runId: run.runId,
        action: 'reassign', role: 'author', agentId: REVIEWER, reason: 'Cover this step' }, OWNER);
      await phone.execute('overrideWorkflowRun', { roomId: ROOM, runId: run.runId,
        action: 'jump', state: 'review', reason: 'Review the current artifact' }, OWNER);
      await phone.execute('overrideWorkflowRun', { roomId: ROOM, runId: run.runId,
        action: 'kill', reason: 'Stop this run' }, OWNER);
      const result = await readWorkflowRun(db, ROOM, run.runId);
      expect(result.run.status).toBe('failed');
      expect(result.log.filter((item) => item.event.startsWith('override_'))
        .map((item) => [item.event, (item.payload as { viewerId: string }).viewerId]))
        .toEqual([['override_reassign', OWNER], ['override_jump', OWNER], ['override_kill', OWNER]]);
    } finally { await db.close(); }
  });

  it('ignores CI for an old head in the built-in code-corner wait', async () => {
    const { db, parent } = await fixture();
    try {
      await db.query(
        `INSERT INTO corner_facts(corner_id,owner_agent_id,objective,lifecycle)
         VALUES($1,$2,'Review', $3::jsonb)`,
        [ROOM, AUTHOR, JSON.stringify({ checks: 'pending', pr: { headSha: 'new-head' } })],
      );
      await db.query(`UPDATE rooms SET parent_id=$2 WHERE id=$1`, [ROOM, OTHER_ROOM]);
      const run = await db.transaction((tx) => startWorkflowRun(tx, ROOM, 'code-corner',
        { implementer: AUTHOR, reviewer: REVIEWER }, parent));
      const commandId = (await db.query<{ command_id: string }>(
        `SELECT command_id FROM workflow_run_assignments WHERE run_id=$1`, [run.runId],
      )).rows[0]!.command_id;
      const command = (await db.query<typeof parent>(
        `SELECT * FROM agent_commands WHERE id=$1`, [commandId],
      )).rows[0]!;
      await db.transaction((tx) => completeWorkflowStep(tx, ROOM, run.runId, 0,
        { head: 'old-head' }, 'success', command));
      expect(await db.transaction((tx) => signalWorkflowEvent(tx, ROOM,
        'check-completed', { sha: 'old-head', outcome: 'success' }, 'old-event'))).toBe(0);
      expect((await readWorkflowRun(db, ROOM, run.runId)).run.state).toBe('ci');
      expect(await db.transaction((tx) => signalWorkflowEvent(tx, ROOM,
        'check-completed', { sha: 'new-head', outcome: 'success' }, 'new-event'))).toBe(1);
      expect((await readWorkflowRun(db, ROOM, run.runId)).run.state).toBe('review');
    } finally { await db.close(); }
  });
  it('pins the definition, validates output, and wakes the next role without a tag', async () => {
    const { db, parent } = await fixture();
    try {
      expect(
        await db.transaction((tx) =>
          putWorkflowDefinition(tx, ROOM, AUTHOR, definition, undefined, parent),
        ),
      ).toEqual({ name: 'review-demo', revision: 1 });
      const run = await db.transaction((tx) =>
        startWorkflowRun(tx, ROOM, 'review-demo', { author: AUTHOR, reviewer: REVIEWER }, parent),
      );
      expect(run).toMatchObject({ state: 'write', status: 'running', revision: 1 });
      const first = (
        await db.query<{ command_id: string }>(
          `SELECT command_id FROM workflow_run_assignments WHERE run_id=$1 AND sequence=0`,
          [run.runId],
        )
      ).rows[0]!;
      const authorCommand = (
        await db.query<typeof parent>(`SELECT * FROM agent_commands WHERE id=$1`, [
          first.command_id,
        ])
      ).rows[0]!;
      const advanced = await db.transaction((tx) =>
        completeWorkflowStep(tx, ROOM, run.runId, 0, { head: 'abc' }, 'success', authorCommand),
      );
      expect(advanced).toEqual({ state: 'review', status: 'running' });
      expect(
        await db.transaction((tx) =>
          completeWorkflowStep(tx, ROOM, run.runId, 0, { head: 'abc' }, 'success', authorCommand),
        ),
      ).toEqual(advanced);
      const next = (
        await db.query<{ agent_id: string }>(
          `SELECT agent_id FROM workflow_run_assignments WHERE run_id=$1 AND sequence=1`,
          [run.runId],
        )
      ).rows[0]!;
      expect(next.agent_id).toBe(REVIEWER);
      expect((await readWorkflowRun(db, ROOM, run.runId)).log.map((event) => event.event)).toEqual([
        'entered',
        'success',
        'entered',
      ]);
      expect((await listWorkflowRuns(db, ROOM)).runs[0]).toMatchObject({
        state: 'review',
        status: 'running',
      });
    } finally {
      await db.close();
    }
  });

  it('reprompts one invalid output and isolates that run', async () => {
    const { db, parent } = await fixture();
    try {
      await db.transaction((tx) =>
        putWorkflowDefinition(tx, ROOM, AUTHOR, definition, undefined, parent),
      );
      const run = await db.transaction((tx) =>
        startWorkflowRun(tx, ROOM, 'review-demo', { author: AUTHOR, reviewer: REVIEWER }, parent),
      );
      const first = (
        await db.query<{ command_id: string }>(
          `SELECT command_id FROM workflow_run_assignments WHERE run_id=$1 AND sequence=0`,
          [run.runId],
        )
      ).rows[0]!;
      const authorCommand = (
        await db.query<typeof parent>(`SELECT * FROM agent_commands WHERE id=$1`, [
          first.command_id,
        ])
      ).rows[0]!;
      const retry = await db.transaction((tx) =>
        completeWorkflowStep(tx, ROOM, run.runId, 0, { head: 4 }, 'success', authorCommand),
      );
      expect(retry).toMatchObject({
        state: 'write',
        status: 'running',
        error: 'head must be string',
      });
      const replacement = (
        await db.query<{ command_id: string }>(
          `SELECT command_id FROM workflow_run_assignments WHERE run_id=$1 AND sequence=0`,
          [run.runId],
        )
      ).rows[0]!;
      expect(replacement.command_id).not.toBe(first.command_id);
      expect((await listWorkflowRuns(db, ROOM)).runs[0]).toMatchObject({
        state: 'write',
        status: 'running',
      });
    } finally {
      await db.close();
    }
  });

  it('waits for the matching external event and then wakes the reviewer', async () => {
    const { db, parent } = await fixture();
    try {
      const eventDefinition = {
        ...definition,
        states: {
          ...definition.states,
          write: {
            ...definition.states.write,
            on: { success: 'wait', failure: 'stopped', timeout: 'stopped' },
          },
          wait: {
            kind: 'wait',
            event: 'check-passed',
            match: { sha: '$.head' },
            timeoutSeconds: 60,
            on: { success: 'review', timeout: 'stopped' },
          },
        },
      };
      await db.transaction((tx) =>
        putWorkflowDefinition(tx, ROOM, AUTHOR, eventDefinition, undefined, parent),
      );
      const run = await db.transaction((tx) =>
        startWorkflowRun(tx, ROOM, 'review-demo', { author: AUTHOR, reviewer: REVIEWER }, parent),
      );
      const first = (
        await db.query<{ command_id: string }>(
          `SELECT command_id FROM workflow_run_assignments WHERE run_id=$1 AND sequence=0`,
          [run.runId],
        )
      ).rows[0]!;
      const command = (
        await db.query<typeof parent>(`SELECT * FROM agent_commands WHERE id=$1`, [
          first.command_id,
        ])
      ).rows[0]!;
      expect(
        await db.transaction((tx) =>
          completeWorkflowStep(tx, ROOM, run.runId, 0, { head: 'abc' }, 'success', command),
        ),
      ).toMatchObject({ state: 'wait', status: 'waiting' });
      expect(
        await db.transaction((tx) =>
          signalWorkflowEvent(tx, ROOM, 'check-passed', { sha: 'old' }, 'event-old'),
        ),
      ).toBe(0);
      expect(
        await db.transaction((tx) =>
          signalWorkflowEvent(tx, ROOM, 'check-passed', { sha: 'abc' }, 'event-current'),
        ),
      ).toBe(1);
      expect((await listWorkflowRuns(db, ROOM)).runs[0]).toMatchObject({
        state: 'review',
        status: 'running',
      });
    } finally {
      await db.close();
    }
  });

  it('moves a timed out wait to its failure state without affecting the Room', async () => {
    const { db, parent } = await fixture();
    try {
      const waitDefinition = {
        ...definition,
        start: 'wait',
        states: {
          wait: {
            kind: 'wait',
            event: 'check-passed',
            timeoutSeconds: 60,
            on: { success: 'review', timeout: 'stopped' },
          },
          review: definition.states.review,
          stopped: definition.states.stopped,
          done: definition.states.done,
        },
      };
      await db.transaction((tx) =>
        putWorkflowDefinition(tx, ROOM, AUTHOR, waitDefinition, undefined, parent),
      );
      const run = await db.transaction((tx) =>
        startWorkflowRun(tx, ROOM, 'review-demo', { author: AUTHOR, reviewer: REVIEWER }, parent),
      );
      const deadline = new Date((await listWorkflowRuns(db, ROOM)).runs[0]!.deadlineAt! + 1);
      expect(await runDueWorkflowDeadlines(db, deadline)).toBe(1);
      expect((await listWorkflowRuns(db, ROOM)).runs[0]).toMatchObject({
        state: 'stopped',
        status: 'failed',
      });
    } finally {
      await db.close();
    }
  });

  it('lets one event id advance only one of two sequential waits', async () => {
    const { db, parent } = await fixture();
    try {
      const wait = (next: string) => ({
        kind: 'wait', event: 'agent:tick', timeoutSeconds: 60, on: { success: next, timeout: 'stopped' },
      });
      await db.transaction((tx) => putWorkflowDefinition(tx, ROOM, AUTHOR, {
        ...definition,
        start: 'first',
        states: { first: wait('second'), second: wait('done'), stopped: { kind: 'terminal' }, done: { kind: 'terminal' } },
      }, undefined, parent));
      await db.transaction((tx) =>
        startWorkflowRun(tx, ROOM, 'review-demo', { author: AUTHOR, reviewer: REVIEWER }, parent));
      const signal = (eventId: string) =>
        db.transaction((tx) => signalWorkflowEvent(tx, ROOM, 'agent:tick', {}, eventId));
      expect(await signal('tick-1')).toBe(1);
      expect(await signal('tick-1')).toBe(0);
      expect((await listWorkflowRuns(db, ROOM)).runs[0]).toMatchObject({ state: 'second', status: 'waiting' });
      expect(await signal('tick-2')).toBe(1);
      expect((await listWorkflowRuns(db, ROOM)).runs[0]).toMatchObject({ state: 'done', status: 'complete' });
    } finally {
      await db.close();
    }
  });

  it('caps a failed CI wait that sends implementation back through another attempt', async () => {
    const { db, parent } = await fixture();
    try {
      const ciDefinition = {
        ...definition,
        states: {
          ...definition.states,
          write: { ...definition.states.write, on: { ...definition.states.write.on, success: 'wait' } },
          wait: {
            kind: 'wait', event: 'check-completed', match: { sha: '$.head' }, timeoutSeconds: 60,
            on: { success: 'review', failure: 'write', timeout: 'stopped' },
            loop: { to: 'write', maxIterations: 1, onExceeded: 'stopped' },
          },
        },
      };
      await db.transaction((tx) => putWorkflowDefinition(tx, ROOM, AUTHOR, ciDefinition, undefined, parent));
      const run = await db.transaction((tx) =>
        startWorkflowRun(tx, ROOM, 'review-demo', { author: AUTHOR, reviewer: REVIEWER }, parent));
      for (let attempt = 0; attempt < 2; attempt++) {
        const assignment = (await db.query<{ command_id: string }>(
          `SELECT command_id FROM workflow_run_assignments WHERE run_id=$1 AND sequence=$2`,
          [run.runId, attempt * 2],
        )).rows[0]!;
        const command = (await db.query<typeof parent>(
          `SELECT * FROM agent_commands WHERE id=$1`, [assignment.command_id],
        )).rows[0]!;
        await db.transaction((tx) => completeWorkflowStep(
          tx, ROOM, run.runId, attempt * 2, { head: `sha-${attempt}` }, 'success', command,
        ));
        expect(await db.transaction((tx) => signalWorkflowEvent(
          tx, ROOM, 'check-completed', { sha: `sha-${attempt}`, outcome: 'failure' }, `ci-${attempt}`,
        ))).toBe(1);
      }
      expect((await listWorkflowRuns(db, ROOM)).runs[0]).toMatchObject({
        state: 'stopped', status: 'failed', error: 'workflow loop cap exceeded',
      });
    } finally {
      await db.close();
    }
  });

  it('binds a human choice to the gate and advances on approval', async () => {
    const { db, parent } = await fixture();
    try {
      const gateDefinition = {
        ...definition,
        start: 'gate',
        states: {
          ...definition.states,
          gate: {
            kind: 'gate',
            human: 'publish',
            timeoutSeconds: 60,
            on: { approved: 'write', denied: 'stopped', timeout: 'stopped' },
          },
          write: {
            ...definition.states.write,
            on: { success: 'review', failure: 'stopped', timeout: 'stopped' },
          },
        },
      };
      await db.transaction((tx) =>
        putWorkflowDefinition(tx, ROOM, AUTHOR, gateDefinition, undefined, parent),
      );
      const run = await db.transaction((tx) =>
        startWorkflowRun(tx, ROOM, 'review-demo', { author: AUTHOR, reviewer: REVIEWER }, parent),
      );
      const gate = (
        await db.query<{ choice_id: string }>(
          `SELECT choice_id FROM workflow_run_gates WHERE run_id=$1`,
          [run.runId],
        )
      ).rows[0]!;
      await db.transaction(async (tx) => {
        await answerRoomChoice(tx, { choiceId: gate.choice_id, optionId: 'A', viewerId: OWNER });
        await settleWorkflowGateChoice(tx, gate.choice_id, 'A', OWNER);
      });
      expect((await listWorkflowRuns(db, ROOM)).runs[0]).toMatchObject({
        state: 'write',
        status: 'running',
      });
    } finally {
      await db.close();
    }
  });

  it('joins parallel outputs only after both assigned agents finish', async () => {
    const { db, parent } = await fixture();
    try {
      const parallel = {
        ...definition,
        start: 'analyze',
        states: {
          analyze: {
            kind: 'parallel',
            steps: [
              {
                role: 'author',
                skill: 'write-change',
                output: { head: 'string' },
                timeoutSeconds: 60,
                retries: 0,
              },
              {
                role: 'reviewer',
                skill: 'review-change',
                output: { verdict: 'string' },
                timeoutSeconds: 60,
                retries: 0,
              },
            ],
            join: 'all',
            deadlineSeconds: 120,
            on: { success: 'done', deadline: 'stopped' },
          },
          stopped: { kind: 'terminal' },
          done: { kind: 'terminal' },
        },
      };
      await db.transaction((tx) =>
        putWorkflowDefinition(tx, ROOM, AUTHOR, parallel, undefined, parent),
      );
      const run = await db.transaction((tx) =>
        startWorkflowRun(tx, ROOM, 'review-demo', { author: AUTHOR, reviewer: REVIEWER }, parent),
      );
      const assigned = (
        await db.query<{ command_id: string }>(
          `SELECT command_id FROM workflow_run_assignments WHERE run_id=$1 ORDER BY slot`,
          [run.runId],
        )
      ).rows;
      const first = (
        await db.query<typeof parent>(`SELECT * FROM agent_commands WHERE id=$1`, [
          assigned[0]!.command_id,
        ])
      ).rows[0]!;
      const second = (
        await db.query<typeof parent>(`SELECT * FROM agent_commands WHERE id=$1`, [
          assigned[1]!.command_id,
        ])
      ).rows[0]!;
      expect(
        await db.transaction((tx) =>
          completeWorkflowStep(tx, ROOM, run.runId, 0, { head: 'abc' }, 'success', first),
        ),
      ).toEqual({ state: 'analyze', status: 'running' });
      expect(
        await db.transaction((tx) =>
          completeWorkflowStep(tx, ROOM, run.runId, 0, { verdict: 'approve' }, 'success', second),
        ),
      ).toEqual({ state: 'done', status: 'complete' });
      expect((await readWorkflowRun(db, ROOM, run.runId)).run.context.analyze).toEqual({
        outputs: [{ head: 'abc' }, { verdict: 'approve' }],
        missing: [],
      });
    } finally {
      await db.close();
    }
  });

  it('fails one parallel assignment after its retry without leaving the join', async () => {
    const { db, parent } = await fixture();
    try {
      const slot = (role: string, field: string) => ({
        role, skill: `${role}-skill`, output: { [field]: 'string' }, timeoutSeconds: 60, retries: 0,
      });
      await db.transaction((tx) => putWorkflowDefinition(tx, ROOM, AUTHOR, {
        ...definition,
        start: 'analyze',
        states: {
          analyze: {
            kind: 'parallel',
            steps: [slot('author', 'head'), slot('reviewer', 'verdict')],
            join: 'any',
            deadlineSeconds: 120,
            on: { success: 'done', deadline: 'stopped' },
          },
          stopped: { kind: 'terminal' },
          done: { kind: 'terminal' },
        },
      }, undefined, parent));
      const run = await db.transaction((tx) =>
        startWorkflowRun(tx, ROOM, 'review-demo', { author: AUTHOR, reviewer: REVIEWER }, parent));
      const commandFor = async (slotIndex: number) => {
        const { command_id } = (await db.query<{ command_id: string }>(
          `SELECT command_id FROM workflow_run_assignments WHERE run_id=$1 AND slot=$2`,
          [run.runId, slotIndex],
        )).rows[0]!;
        return (await db.query<typeof parent>(
          `SELECT * FROM agent_commands WHERE id=$1`, [command_id],
        )).rows[0]!;
      };
      const invalid = async () => {
        const command = await commandFor(0);
        return db.transaction((tx) =>
          completeWorkflowStep(tx, ROOM, run.runId, 0, { wrong: 1 }, 'success', command));
      };
      expect(await invalid()).toMatchObject({ state: 'analyze', status: 'running' });
      expect(await invalid()).toMatchObject({ state: 'analyze', status: 'running' });
      expect((await db.query<{ status: string }>(
        `SELECT status FROM workflow_run_assignments WHERE run_id=$1 AND slot=0`, [run.runId],
      )).rows[0]!.status).toBe('failed');
      const reviewer = await commandFor(1);
      expect(await db.transaction((tx) => completeWorkflowStep(
        tx, ROOM, run.runId, 0, { verdict: 'approve' }, 'success', reviewer,
      ))).toEqual({ state: 'done', status: 'complete' });
      expect((await readWorkflowRun(db, ROOM, run.runId)).run.context.analyze).toEqual({
        outputs: [{ verdict: 'approve' }],
        missing: ['author'],
      });
    } finally {
      await db.close();
    }
  });

  it('starts an event triggered run once for the same event id', async () => {
    const { db, parent } = await fixture();
    try {
      const eventDefinition = { ...definition, trigger: { kind: 'event', value: 'agent:ready' } };
      await db.transaction((tx) =>
        putWorkflowDefinition(
          tx,
          ROOM,
          AUTHOR,
          eventDefinition,
          { author: AUTHOR, reviewer: REVIEWER },
          parent,
        ),
      );
      await db.transaction((tx) => signalWorkflowEvent(tx, ROOM, 'agent:ready', {}, 'event-one'));
      await db.transaction((tx) => signalWorkflowEvent(tx, ROOM, 'agent:ready', {}, 'event-one'));
      expect((await listWorkflowRuns(db, ROOM)).runs).toHaveLength(1);
    } finally {
      await db.close();
    }
  });

  it('fires a due schedule through the background runner', async () => {
    const { db, parent } = await fixture();
    try {
      const scheduled = { ...definition, trigger: { kind: 'schedule', value: '* * * * *' } };
      await db.transaction((tx) =>
        putWorkflowDefinition(
          tx,
          ROOM,
          AUTHOR,
          scheduled,
          { author: AUTHOR, reviewer: REVIEWER },
          parent,
        ),
      );
      await db.query(
        `UPDATE workflow_definitions SET next_run_at=now()-interval '1 minute' WHERE room_id=$1`,
        [ROOM],
      );
      expect(await runDueWorkflowSchedules(db)).toBe(1);
      expect((await listWorkflowRuns(db, ROOM)).runs).toHaveLength(1);
    } finally {
      await db.close();
    }
  });

  it('routes a review verdict from the output and enforces the loop cap', async () => {
    const { db, parent } = await fixture();
    try {
      const guarded = {
        ...definition,
        states: {
          ...definition.states,
          review: {
            ...definition.states.review,
            step: {
              ...definition.states.review.step,
              output: { verdict: { type: 'string', enum: ['approve', 'changes'] } },
            },
            guard: { field: 'verdict' },
            on: { approve: 'done', changes: 'write', failure: 'stopped', timeout: 'stopped' },
            loop: { to: 'write', maxIterations: 1, onExceeded: 'stopped' },
          },
        },
      };
      await db.transaction((tx) =>
        putWorkflowDefinition(tx, ROOM, AUTHOR, guarded, undefined, parent),
      );
      const run = await db.transaction((tx) =>
        startWorkflowRun(tx, ROOM, 'review-demo', { author: AUTHOR, reviewer: REVIEWER }, parent),
      );
      const currentCommand = async (sequence: number) => {
        const row = (
          await db.query<{ command_id: string }>(
            `SELECT command_id FROM workflow_run_assignments WHERE run_id=$1 AND sequence=$2`,
            [run.runId, sequence],
          )
        ).rows[0]!;
        return (
          await db.query<typeof parent>(`SELECT * FROM agent_commands WHERE id=$1`, [
            row.command_id,
          ])
        ).rows[0]!;
      };
      const first = await currentCommand(0);
      await db.transaction((tx) =>
        completeWorkflowStep(tx, ROOM, run.runId, 0, { head: 'a' }, 'success', first),
      );
      const second = await currentCommand(1);
      expect(
        await db.transaction((tx) =>
          completeWorkflowStep(tx, ROOM, run.runId, 1, { verdict: 'changes' }, 'success', second),
        ),
      ).toMatchObject({ state: 'write' });
      const third = await currentCommand(2);
      await db.transaction((tx) =>
        completeWorkflowStep(tx, ROOM, run.runId, 2, { head: 'b' }, 'success', third),
      );
      const fourth = await currentCommand(3);
      expect(
        await db.transaction((tx) =>
          completeWorkflowStep(tx, ROOM, run.runId, 3, { verdict: 'changes' }, 'success', fourth),
        ),
      ).toMatchObject({ state: 'stopped', status: 'failed', error: 'workflow loop cap exceeded' });
    } finally {
      await db.close();
    }
  }, 15_000);
});
