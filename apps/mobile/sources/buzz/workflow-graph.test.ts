import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorkflowContract, WorkflowRunStepView } from '@beeline/api-contract/phone';
import {
  workflowDisplayName,
  workflowMainPath,
  workflowRunLine,
  workflowStateLabel,
  type WorkflowLineStep,
} from './workflow-graph';
import { SYSTEM_IDENTITY_PUBKEY } from './system-identity';
import {
  formatRunDuration,
  loopRoundLabel,
  workflowRunHeadline,
  workflowStepAssignee,
  workflowStepMeta,
} from './workflow-run-copy';

const repo = path.resolve(__dirname, '../../../..');
const feedbackTriage = JSON.parse(
  readFileSync(path.join(repo, 'docs/workflows/feedback-triage.json'), 'utf8'),
) as WorkflowContract;

/** A copy of the server's `CORNER_WORKFLOW_CONTRACT` (apps/server/src/corner-workflow.ts). */
const corner: WorkflowContract = {
  version: 1,
  name: 'corner',
  description: 'Corner lifecycle: implement, check, review, merge, or close',
  roles: ['implementer', 'reviewer'],
  start: 'opened',
  handoffs: {
    opened: { kind: 'server', requires: [], on: { no_code: 'no_code_work', code: 'implement' } },
    no_code_work: { role: 'implementer', requires: [], on: { upgrade_requested: 'upgrade_to_code' } },
    upgrade_to_code: {
      kind: 'server',
      requires: ['branch', 'repositoryRoute', 'ciCallbackRegistered', 'mergeTarget'],
      on: { upgraded: 'implement' },
    },
    implement: {
      role: 'implementer',
      requires: [],
      on: { pushed: 'checks', rechecked: 'checks', rereview: 'review' },
    },
    checks: {
      kind: 'server',
      requires: [],
      on: { passing: 'review', failing: 'implement', no_reviewer: 'implement' },
      loop: { onEdge: 'failing', cap: 100, onExceeded: 'ask_human' },
    },
    review: {
      role: 'reviewer',
      roleBinding: 'live:parent.reviewer_agent_id',
      requires: [],
      on: { approved: 'land', changes_requested: 'implement', pushed: 'checks', rechecked: 'checks' },
      loop: { onEdge: 'changes_requested', cap: 3, onExceeded: 'ask_human' },
    },
    land: {
      kind: 'server',
      requires: [],
      on: { merge_refused: 'implement', pushed: 'checks', rechecked: 'checks' },
    },
    ask_human: { kind: 'server', requires: [], on: { pushed: 'checks' } },
    landed: { kind: 'terminal', status: 'done' },
    closed: { kind: 'terminal', status: 'abandoned' },
  },
  implicitEdges: ['landed', 'closed'],
  externalOutcomes: ['pushed', 'rechecked', 'rereview', 'merge_refused'],
};

const serverCornerSource = readFileSync(
  path.join(repo, 'apps/server/src/corner-workflow.ts'),
  'utf8',
);

const candy = { id: 'b'.repeat(64), name: 'Candy', kind: 'agent' as const };
const owner = { id: 'a'.repeat(64), name: 'Owner', kind: 'human' as const };

function rowsOf(line: readonly WorkflowLineStep[]) {
  return line.map((step) => [step.state, step.status]);
}

function metaOf(
  line: readonly WorkflowLineStep[],
  contract: WorkflowContract,
  history: readonly WorkflowRunStepView[],
  viewerHolds = false,
) {
  return line.map((step) => workflowStepMeta(step, { contract, run: { viewerHolds }, history }));
}

function assigneesOf(
  line: readonly WorkflowLineStep[],
  contract: WorkflowContract,
  viewerHolds = false,
) {
  return line.map(
    (step) =>
      workflowStepAssignee(step, {
        contract,
        roleHolders: { triager: candy, implementer: candy },
        run: { viewerHolds, holder: candy },
        viewer: owner,
      })?.name,
  );
}

describe('workflowMainPath', () => {
  it("follows each state's first outcome from start to a terminal", () => {
    expect(workflowMainPath(feedbackTriage)).toEqual(['notify', 'pull', 'approve', 'dispatch', 'done']);
  });

  it('steps past an outcome that loops back, and ends on the first implicit terminal', () => {
    // land's outcomes all return up the line, so the line ends on `landed`.
    expect(workflowMainPath(corner)).toEqual([
      'opened',
      'no_code_work',
      'upgrade_to_code',
      'implement',
      'checks',
      'review',
      'land',
      'landed',
    ]);
  });
});

describe('workflowRunLine · feedback-triage', () => {
  it('reads a live run waiting at its gate as done, current, then not yet reached', () => {
    const history = [
      { toState: 'notify', at: 100, actor: candy },
      { fromState: 'notify', outcome: 'notified', toState: 'pull', at: 112, actor: candy, contents: { fixedPullRequests: [] } },
      { fromState: 'pull', outcome: 'ranked', toState: 'approve', at: 212, actor: candy, contents: { problems: ['a'] } },
    ];
    const line = workflowRunLine(feedbackTriage, history);
    expect(rowsOf(line)).toEqual([
      ['notify', 'done'],
      ['pull', 'done'],
      ['approve', 'current'],
      ['dispatch', 'pending'],
      ['done', 'pending'],
    ]);
    expect(line.every((step) => step.onMainPath)).toBe(true);
    expect(metaOf(line, feedbackTriage, history, true)).toEqual([
      '',
      '',
      'Your call · gate',
      '',
      'Ends the run',
    ]);
    // Who held each step is its mark: the gate waiting on the viewer is theirs.
    expect(assigneesOf(line, feedbackTriage, true)).toEqual([
      'Candy',
      'Candy',
      'Owner',
      'Candy',
      undefined,
    ]);
    // A visit carries what the state handed off when it left, and how.
    expect(line[1]!.visits).toEqual([
      {
        enteredAt: 112,
        leftAt: 212,
        outcome: 'ranked',
        nextState: 'approve',
        leftBy: candy,
        delivered: { problems: ['a'] },
      },
    ]);
    expect(line[2]!.visits[0]!.leftAt).toBeUndefined();
  });

  it('skips the states a fork went around, and says why', () => {
    const history = [
      { toState: 'notify', at: 100 },
      { fromState: 'notify', outcome: 'notified', toState: 'pull', at: 109 },
      { fromState: 'pull', outcome: 'nothing_new', toState: 'done', status: 'done' as const, at: 158 },
    ];
    const line = workflowRunLine(feedbackTriage, history);
    expect(rowsOf(line)).toEqual([
      ['notify', 'done'],
      ['pull', 'done'],
      ['approve', 'skipped'],
      ['dispatch', 'skipped'],
      ['done', 'done'],
    ]);
    expect(line[2]!.skippedBy).toEqual({ state: 'pull', outcome: 'nothing_new' });
    expect(metaOf(line, feedbackTriage, history).slice(2)).toEqual([
      'Skipped · Pull: nothing new',
      'Skipped · Pull: nothing new',
      'Ended by Pull',
    ]);
    expect(workflowRunHeadline({ status: 'done', viewerHolds: false, state: 'done' }, 'nothing_new')).toBe(
      'Done · nothing new',
    );
  });

  it("keeps the gate's record and the corners a step opened on the visit they belong to", () => {
    const gate = {
      question: 'feedback-triage: approve',
      options: [{ letter: 'A', label: 'dispatch', consequence: 'go to dispatch' }],
      status: 'answered' as const,
      answer: 'dispatch',
      answeredBy: { id: 'a'.repeat(64), name: 'Owner', kind: 'human' as const },
    };
    const opened = [{ id: 'corner-9', name: 'Fix it', parentRoomId: 'room-1' }];
    const history = [
      { toState: 'pull', at: 1 },
      { fromState: 'pull', outcome: 'ranked', toState: 'approve', at: 2, gate },
      { fromState: 'approve', outcome: 'dispatch', toState: 'dispatch', at: 3, openedCorners: opened },
      { fromState: 'dispatch', outcome: 'dispatched', toState: 'done', at: 4, contents: { corners: ['Fix it'] } },
    ];
    const line = workflowRunLine(feedbackTriage, history);
    // The settled gate names who answered it.
    expect(metaOf(line, feedbackTriage, history)[2]).toBe('');
    // A settled gate is the person who answered it, not the agent that asked.
    expect(assigneesOf(line, feedbackTriage)[2]).toBe('Owner');
    const byState = Object.fromEntries(line.map((step) => [step.state, step]));
    expect(byState.approve!.visits[0]).toMatchObject({ gate, outcome: 'dispatch' });
    expect(byState.dispatch!.visits[0]).toMatchObject({
      openedCorners: opened,
      delivered: { corners: ['Fix it'] },
    });
    expect(byState.notify!.status).toBe('skipped');
  });
});

describe('workflowStepAssignee', () => {
  it('names the bound holder, not the system identity, on a corner step the server closed', () => {
    const system = { id: SYSTEM_IDENTITY_PUBKEY, name: 'Beeline', kind: 'agent' as const };
    const history = [
      { toState: 'opened', actor: system, at: 0 },
      { fromState: 'opened', outcome: 'code', toState: 'implement', actor: system, at: 10 },
      { fromState: 'implement', outcome: 'pushed', toState: 'checks', actor: system, at: 20 },
    ];
    const line = workflowRunLine(corner, history);
    const byState = Object.fromEntries(line.map((step) => [step.state, step]));
    expect(byState.implement!.status).toBe('done');
    expect(assigneesOf([byState.implement!, byState.checks!], corner)).toEqual(['Candy', undefined]);
  });
});

describe('workflowRunLine · corner', () => {
  it('matches the server contract it copies', () => {
    for (const state of Object.keys(corner.handoffs))
      expect(serverCornerSource).toContain(`    ${state}: {`);
    expect(serverCornerSource).toContain("implicitEdges: ['landed', 'closed']");
  });

  const looped = [
    { toState: 'opened', at: 0 },
    { fromState: 'opened', outcome: 'code', toState: 'implement', at: 10 },
    { fromState: 'implement', outcome: 'pushed', toState: 'checks', at: 1_870 },
    { fromState: 'checks', outcome: 'failing', toState: 'implement', at: 2_410 },
    { fromState: 'implement', outcome: 'pushed', toState: 'checks', at: 3_430 },
    { fromState: 'checks', outcome: 'passing', toState: 'review', at: 4_150 },
    { fromState: 'review', outcome: 'changes_requested', toState: 'implement', at: 4_330 },
  ];

  it('folds loops into one row per state, ×N visits, never drawing back up the line', () => {
    const line = workflowRunLine(corner, looped);
    expect(rowsOf(line)).toEqual([
      ['opened', 'done'],
      ['no_code_work', 'skipped'],
      ['upgrade_to_code', 'skipped'],
      ['implement', 'current'],
      ['checks', 'done'],
      ['review', 'done'],
      ['land', 'pending'],
      ['landed', 'pending'],
    ]);
    const byState = Object.fromEntries(line.map((step) => [step.state, step]));
    expect(byState.implement!.visits.map((visit) => visit.outcome)).toEqual(['pushed', 'pushed', undefined]);
    expect(byState.checks!.visits.map((visit) => [visit.outcome, visit.leftAt! - visit.enteredAt])).toEqual([
      ['failing', 540],
      ['passing', 720],
    ]);
    expect(byState.checks!.loop).toEqual({ taken: 1, cap: 100 });
    expect(byState.review!.loop).toEqual({ taken: 1, cap: 3 });
    expect(loopRoundLabel(byState.review!.loop)).toBe('round 2 of 3');
    expect(loopRoundLabel({ taken: 3, cap: 3 })).toBe('round 3 of 3');
    expect(loopRoundLabel({ taken: 0, cap: 3 })).toBeUndefined();
    expect(byState.no_code_work!.skippedBy).toEqual({ state: 'opened', outcome: 'code' });
  });

  it('splices an off-path state in where the run entered it', () => {
    const line = workflowRunLine(corner, [
      ...looped.slice(0, 3),
      { fromState: 'checks', outcome: 'failing', toState: 'ask_human', at: 2_000 },
    ]);
    expect(rowsOf(line)).toEqual([
      ['opened', 'done'],
      ['no_code_work', 'skipped'],
      ['upgrade_to_code', 'skipped'],
      ['implement', 'done'],
      ['checks', 'done'],
      ['ask_human', 'current'],
      ['review', 'pending'],
      ['land', 'pending'],
      ['landed', 'pending'],
    ]);
    expect(line.find((step) => step.state === 'ask_human')!.onMainPath).toBe(false);
    // `closed` is never on the line unless the run went there.
    expect(line.some((step) => step.state === 'closed')).toBe(false);
  });

  it('ends a closed corner at Closed, failed, and skips what it never reached', () => {
    const history = [
      ...looped.slice(0, 6),
      { fromState: 'review', outcome: 'closed', toState: 'closed', status: 'abandoned' as const, at: 4_200 },
    ];
    const line = workflowRunLine(corner, history);
    expect(rowsOf(line)).toEqual([
      ['opened', 'done'],
      ['no_code_work', 'skipped'],
      ['upgrade_to_code', 'skipped'],
      ['implement', 'done'],
      ['checks', 'done'],
      ['review', 'done'],
      ['closed', 'failed'],
      ['land', 'skipped'],
      ['landed', 'skipped'],
    ]);
    const meta = metaOf(line, corner, history);
    expect(meta[6]).toBe('Abandoned · ended by Review');
    expect(meta[7]).toBe('Skipped · run ended at Closed');
  });
});

describe('workflow copy', () => {
  it('turns slugs and state names into sentence case', () => {
    expect(workflowDisplayName('feedback-triage')).toBe('Feedback triage');
    expect(workflowStateLabel('ask_human')).toBe('Ask human');
    expect(workflowStateLabel('no_code_work')).toBe('No code work');
  });

  it('reads durations the way a run log does', () => {
    expect(formatRunDuration(9)).toBe('9s');
    expect(formatRunDuration(125)).toBe('2m 05s');
    expect(formatRunDuration(48 * 60 + 10)).toBe('48m');
    expect(formatRunDuration(72 * 60)).toBe('1h 12m');
  });

  it('heads a live run by whose move it is', () => {
    expect(workflowRunHeadline({ status: 'live', viewerHolds: true, state: 'approve' })).toBe('Waiting on you');
    expect(workflowRunHeadline({ status: 'live', viewerHolds: false, state: 'review' })).toBe('In review');
  });
});
