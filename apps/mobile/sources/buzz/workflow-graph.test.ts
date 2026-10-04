import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorkflowContract, WorkflowRunStepView } from '@beeline/api-contract/phone';
import {
  workflowDisplayName,
  workflowRunLine,
  workflowStateLabel,
  type WorkflowLineStep,
} from './workflow-graph';
import { SYSTEM_IDENTITY_PUBKEY } from './system-identity';
import {
  formatRunDuration,
  workflowRunHeadline,
  workflowStepAssignee,
  workflowStepMeta,
  stepSeconds,
} from './workflow-run-copy';

const repo = path.resolve(__dirname, '../../../..');
const feedbackTriage = JSON.parse(
  readFileSync(path.join(repo, 'docs/workflows/feedback-triage.json'), 'utf8'),
) as WorkflowContract;

/** A copy of the server's `CORNER_LIFECYCLE_CONTRACT` (apps/server/src/corner-lifecycle.ts). */
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
  path.join(repo, 'apps/server/src/corner-lifecycle.ts'),
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

describe('workflowRunLine execution history', () => {
  it('shows only reached states in order, without future terminal rows', () => {
    const history = [{ toState: 'notify', at: 100 },
      { fromState: 'notify', outcome: 'notified', toState: 'pull', at: 112 },
      { fromState: 'pull', outcome: 'nothing_new', toState: 'done', at: 212 }];
    expect(rowsOf(workflowRunLine(feedbackTriage, history))).toEqual([
      ['notify', 'done'], ['pull', 'done'], ['done', 'done']]);
    expect(workflowRunLine(feedbackTriage)).toEqual([]);
  });
  it('preserves separate repeated visits, output, actors, and stable finished durations', () => {
    const history = [{ visitId: 'one', toState: 'implement', at: 100,
      finalReply: { messageId: 'final-one', text: 'First result' } },
      { visitId: 'two', fromState: 'implement', outcome: 'pushed', toState: 'checks', actor: candy, at: 112 },
      { visitId: 'three', fromState: 'checks', outcome: 'failing', toState: 'implement', at: 212,
        outputTurns: ['turn-three'], liveOutput: 'Newest chunk' }];
    const line = workflowRunLine(corner, history);
    expect(rowsOf(line)).toEqual([['implement', 'done'], ['checks', 'done'], ['implement', 'current']]);
    expect(line.map((step) => step.visitId)).toEqual(['one', 'two', 'three']);
    expect(line[0]!.visits[0]).toMatchObject({ enteredAt: 100, leftAt: 112,
      leftBy: candy, finalReply: { text: 'First result' } });
    expect(line[2]!.visits[0]).toMatchObject({ liveOutput: 'Newest chunk', outputTurns: ['turn-three'] });
    expect(stepSeconds(line[0]!, 400)).toBe(12);
    expect(stepSeconds(line[0]!, 500)).toBe(12);
    expect(stepSeconds(line[2]!, 400)).toBe(188);
    expect(stepSeconds(line[2]!, 500)).toBe(288);
  });
  it('keeps gate records and opened corners on their own visit', () => {
    const gate = { question: 'Proceed?', options: [], status: 'answered' as const, answer: 'dispatch', answeredBy: owner };
    const openedCorners = [{ id: 'fix', name: 'Fix', parentRoomId: 'room' }];
    const line = workflowRunLine(feedbackTriage, [
      { toState: 'approve', at: 100, gate },
      { fromState: 'approve', outcome: 'dispatch', toState: 'dispatch', at: 120, openedCorners },
      { fromState: 'dispatch', outcome: 'dispatched', toState: 'done', at: 200 }]);
    expect(line[0]!.visits[0]!.gate).toBe(gate);
    expect(line[1]!.visits[0]!.openedCorners).toBe(openedCorners);
    expect(line[2]!.visits[0]!.gate).toBeUndefined();
    expect(assigneesOf(line, feedbackTriage)).toEqual(['Owner', 'Candy', undefined]);
  });
  it('keeps a cancellation exit stable without adding a second visit', () => {
    const line = workflowRunLine(feedbackTriage, [{ toState: 'pull', at: 100 },
      { fromState: 'pull', toState: 'pull', status: 'abandoned', at: 120 }]);
    expect(rowsOf(line)).toEqual([['pull', 'done']]);
    expect(stepSeconds(line[0]!, 300)).toBe(20);
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
