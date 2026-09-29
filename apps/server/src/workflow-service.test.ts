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
} from './workflow-service.js';
import { answerRoomChoice } from './room-choice.js';

const OWNER = 'a'.repeat(64);
const AUTHOR = 'b'.repeat(64);
const REVIEWER = 'c'.repeat(64);
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const ROOM = '22222222-2222-4222-8222-222222222222';
const SOURCE = 'd'.repeat(64);

const definition = {
  version: 1,
  name: 'review-demo',
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
  await db.query(
    `INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES ($1,$2,$3,'owner'),($1,$2,$4,'member'),($1,$2,$5,'member')`,
    [WORKSPACE, ROOM, OWNER, AUTHOR, REVIEWER],
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
