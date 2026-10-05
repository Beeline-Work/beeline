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
import {
  formatRunDuration,
  workflowRunHeadline,
  workflowStepAssignee,
  stepSeconds,
} from './workflow-run-copy';

const repo = path.resolve(__dirname, '../../../..');
const feedbackTriage = JSON.parse(
  readFileSync(path.join(repo, 'docs/workflows/feedback-triage.json'), 'utf8'),
) as WorkflowContract;

const candy = { id: 'b'.repeat(64), name: 'Candy', kind: 'agent' as const };
const owner = { id: 'a'.repeat(64), name: 'Owner', kind: 'human' as const };

function rowsOf(line: readonly WorkflowLineStep[]) {
  return line.map((step) => [step.state, step.status]);
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
  it('uses the server visit status instead of inferring a current step from the definition', () => {
    const line = workflowRunLine(feedbackTriage, [
      { toState: 'pull', at: 100, displayStatus: 'failed' },
    ], 'failed');
    expect(rowsOf(line)).toEqual([['pull', 'failed']]);
  });

  it('closes the failed visit at the deadline and keeps older server responses working', () => {
    const line = workflowRunLine(feedbackTriage, [
      { toState: 'pull', at: 100 },
      { fromState: 'pull', toState: 'pull', status: 'failed', outcome: 'deadline', at: 120 },
    ], 'failed');
    expect(rowsOf(line)).toEqual([['pull', 'failed']]);
    expect(stepSeconds(line[0]!, 300)).toBe(20);
  });

  it('shows only reached states in order, without future terminal rows', () => {
    const history = [{ toState: 'notify', at: 100 },
      { fromState: 'notify', outcome: 'notified', toState: 'pull', at: 112 },
      { fromState: 'pull', outcome: 'nothing_new', toState: 'done', at: 212 }];
    expect(rowsOf(workflowRunLine(feedbackTriage, history))).toEqual([
      ['notify', 'done'], ['pull', 'done'], ['done', 'done']]);
    expect(workflowRunLine(feedbackTriage)).toEqual([]);
  });
  it('preserves separate repeated visits, output, actors, and stable finished durations', () => {
    const history = [{ visitId: 'one', toState: 'pull', at: 100,
      finalReply: { messageId: 'final-one', text: 'First result' } },
      { visitId: 'two', fromState: 'pull', outcome: 'ranked', toState: 'approve', actor: candy, at: 112 },
      { visitId: 'three', fromState: 'approve', outcome: 'dispatch', toState: 'dispatch', at: 212,
        outputTurns: ['turn-three'], liveOutput: 'Newest chunk' }];
    const line = workflowRunLine(feedbackTriage, history);
    const reached = line.slice(0, 3);
    expect(rowsOf(reached)).toEqual([['pull', 'done'], ['approve', 'done'], ['dispatch', 'current']]);
    expect(reached.map((step) => step.visitId)).toEqual(['one', 'two', 'three']);
    expect(reached[0]!.visits[0]).toMatchObject({ enteredAt: 100, leftAt: 112,
      leftBy: candy, finalReply: { text: 'First result' } });
    expect(reached[2]!.visits[0]).toMatchObject({ liveOutput: 'Newest chunk', outputTurns: ['turn-three'] });
    expect(stepSeconds(reached[0]!, 400)).toBe(12);
    expect(stepSeconds(reached[0]!, 500)).toBe(12);
    expect(stepSeconds(reached[2]!, 400)).toBe(188);
    expect(stepSeconds(reached[2]!, 500)).toBe(288);
  });
  it('predicts the rest of the path from the current state, stopping at the first predicted terminal', () => {
    const line = workflowRunLine(feedbackTriage, [{ toState: 'notify', at: 100 }]);
    expect(rowsOf(line)).toEqual([
      ['notify', 'current'], ['pull', 'pending'], ['approve', 'pending'],
      ['dispatch', 'pending'], ['done', 'pending'],
    ]);
    expect(line.slice(1).every((step) => step.visits.length === 0)).toBe(true);
    // A terminal run has nothing left to predict.
    const ended = workflowRunLine(feedbackTriage, [{ toState: 'notify', at: 100 },
      { fromState: 'notify', outcome: 'notified', toState: 'pull', at: 110 },
      { fromState: 'pull', outcome: 'nothing_new', toState: 'done', at: 120 }]);
    expect(rowsOf(ended)).toEqual([['notify', 'done'], ['pull', 'done'], ['done', 'done']]);
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
    expect(workflowRunHeadline({ status: 'live', viewerHolds: true })).toBe('Waiting on you');
    expect(workflowRunHeadline({ status: 'live', viewerHolds: false })).toBe('Running');
  });
});
