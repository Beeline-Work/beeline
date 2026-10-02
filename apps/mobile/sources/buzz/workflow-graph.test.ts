import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WorkflowContract } from '@beeline/api-contract/phone';
import {
  GRAPH_NODE_Y,
  GRAPH_ROW,
  layoutWorkflowGraph,
  workflowDisplayName,
  workflowStateLabel,
  type WorkflowGraphLayout,
} from './workflow-graph';
import { loopRoundLabel } from './workflow-run-copy';

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

function rowsOf(layout: WorkflowGraphLayout) {
  return layout.rows.map((row) => [row.state, row.column, row.reach]);
}

/** No two circles share a row, and no line passes through a circle it does not end at. */
function expectNoCollisions(layout: WorkflowGraphLayout) {
  const ys = layout.rows.map((row) => row.y);
  expect(new Set(ys).size).toBe(ys.length);
  const spans = layout.laneSpans;
  for (let a = 0; a < spans.length; a += 1)
    for (let b = a + 1; b < spans.length; b += 1)
      if (spans[a]!.column === spans[b]!.column)
        expect(
          spans[a]!.from > spans[b]!.to || spans[b]!.from > spans[a]!.to,
          `lane ${spans[a]!.column} used twice over rows ${JSON.stringify([spans[a], spans[b]])}`,
        ).toBe(true);
  // Every row's circle sits on its own lane, inside that lane's span.
  layout.rows.forEach((row, index) => {
    expect(
      spans.some((span) => span.column === row.column && span.from <= index && index <= span.to),
    ).toBe(true);
  });
}

/** Every edge that leaves a non-terminal row ends on a row: no fork is a no-op. */
function expectEveryBranchEndsInAState(layout: WorkflowGraphLayout, contract: WorkflowContract) {
  layout.rows.forEach((row, index) => {
    const state = contract.handoffs[row.state]!;
    if (state.kind === 'terminal' || state.kind === 'waiting') return;
    const targets = new Set(Object.values(state.on));
    if ('loop' in state && state.loop) targets.add(state.loop.onExceeded);
    const drawn = layout.edges.filter((edge) => edge.from === index).map((edge) => layout.rows[edge.to]!.state);
    expect(new Set(drawn)).toEqual(targets);
  });
}

describe('layoutWorkflowGraph · feedback-triage (mock v11 frame C)', () => {
  const history = [
    { toState: 'notify', at: 100 },
    { fromState: 'notify', outcome: 'notified', toState: 'pull', at: 200 },
    { fromState: 'pull', outcome: 'ranked', toState: 'approve', at: 300 },
  ];
  const layout = layoutWorkflowGraph(feedbackTriage, history);

  it('puts each state on one row, forks onto the branch lane, and repeats Done per branch', () => {
    expect(rowsOf(layout)).toEqual([
      ['notify', 0, 'traversed'],
      ['pull', 0, 'traversed'],
      ['done', 1, 'unreachable'],
      ['approve', 0, 'current'],
      ['done', 1, 'reachable'],
      ['dispatch', 0, 'reachable'],
      ['done', 0, 'reachable'],
    ]);
    // The mock's lanes: main x=28, branch x=46, rows 64 apart, circle 22.5 down.
    expect(layout.rows.map((row) => row.x)).toEqual([28, 28, 46, 28, 46, 28, 28]);
    expect(layout.rows.map((row) => row.y)).toEqual(
      [0, 1, 2, 3, 4, 5, 6].map((index) => index * GRAPH_ROW + GRAPH_NODE_Y),
    );
    expect(layout.width).toBe(60);
    expect(layout.rows.filter((row) => row.state === 'done').map((row) => row.inOutcomes)).toEqual([
      ['nothing_new'],
      ['skip'],
      ['dispatched'],
    ]);
  });

  it('marks the path taken in brass and nothing else', () => {
    const traversed = layout.edges
      .filter((edge) => edge.traversed)
      .map((edge) => [layout.rows[edge.from]!.state, layout.rows[edge.to]!.state]);
    expect(traversed).toEqual([
      ['notify', 'pull'],
      ['pull', 'approve'],
    ]);
    // The fork from Pull to its Done is the mock's curve: down out of the circle, onto lane 46.
    const fork = layout.edges.find((edge) => edge.from === 1 && edge.to === 2)!;
    expect(fork.kind).toBe('fork');
    expect(fork.path).toBe('M28 91 C28 108 46 102 46 120 L46 146');
    expect(layout.chevrons).toEqual([]);
    expectNoCollisions(layout);
    expectEveryBranchEndsInAState(layout, feedbackTriage);
  });
});

describe('layoutWorkflowGraph · corner (mock v11 frame D)', () => {
  it('matches the server contract it copies', () => {
    for (const state of Object.keys(corner.handoffs))
      expect(serverCornerSource).toContain(`    ${state}: {`);
    expect(serverCornerSource).toContain("implicitEdges: ['landed', 'closed']");
  });

  const history = [
    { toState: 'opened', at: 1 },
    { fromState: 'opened', outcome: 'code', toState: 'implement', at: 2 },
    { fromState: 'implement', outcome: 'pushed', toState: 'checks', at: 3 },
    { fromState: 'checks', outcome: 'passing', toState: 'review', at: 4 },
    { fromState: 'review', outcome: 'changes_requested', toState: 'implement', at: 5 },
    { fromState: 'implement', outcome: 'pushed', toState: 'checks', at: 6 },
    { fromState: 'checks', outcome: 'passing', toState: 'review', at: 7 },
  ];
  const layout = layoutWorkflowGraph(corner, history);

  it('draws forks, the ask_human branch, every back edge, and both terminals', () => {
    expect(rowsOf(layout)).toEqual([
      ['opened', 0, 'traversed'],
      ['no_code_work', 0, 'unreachable'],
      ['upgrade_to_code', 0, 'unreachable'],
      ['implement', 0, 'traversed'],
      ['checks', 0, 'traversed'],
      ['review', 0, 'current'],
      ['land', 0, 'reachable'],
      ['ask_human', 1, 'reachable'],
      ['landed', 0, 'reachable'],
      ['closed', 0, 'reachable'],
    ]);
    expect(layout.rows.filter((row) => row.implicit).map((row) => row.state)).toEqual([
      'landed',
      'closed',
    ]);
    const backs = layout.edges.filter((edge) => edge.kind === 'back');
    expect(
      backs.map((edge) => `${layout.rows[edge.from]!.state}>${layout.rows[edge.to]!.state}`).sort(),
    ).toEqual(
      [
        'checks>implement',
        'review>implement',
        'land>implement',
        'review>checks',
        'land>checks',
        'ask_human>checks',
      ].sort(),
    );
    // One up chevron per state a loop returns to.
    expect(layout.chevrons).toHaveLength(2);
    expectNoCollisions(layout);
    expectEveryBranchEndsInAState(layout, corner);
  });

  it('brasses the loop the run took and counts its rounds', () => {
    const traversedBack = layout.edges
      .filter((edge) => edge.kind === 'back' && edge.traversed)
      .map((edge) => `${layout.rows[edge.from]!.state}>${layout.rows[edge.to]!.state}`);
    expect(traversedBack).toEqual(['review>implement']);
    expect(layout.chevrons.filter((chevron) => chevron.traversed)).toHaveLength(1);
    const review = layout.rows.find((row) => row.state === 'review')!;
    expect(review.loop).toEqual({ taken: 1, cap: 3 });
    // One send-back on a cap of 3 is the second trip, still inside the cap.
    expect(loopRoundLabel(review.loop)).toBe('round 2 of 3');
    expect(loopRoundLabel({ taken: 3, cap: 3 })).toBe('round 3 of 3');
    expect(loopRoundLabel({ taken: 0, cap: 3 })).toBeUndefined();
    expect(review.visits).toBe(2);
    expect(review.enteredAt).toBe(7);
    expect(layout.rows.find((row) => row.state === 'implement')!.lastOutcome).toBe('pushed');
  });

  it('draws an implicit jump only when the run took it', () => {
    const closedRun = layoutWorkflowGraph(corner, [
      ...history,
      { fromState: 'review', outcome: 'closed', toState: 'closed', at: 8 },
    ]);
    const closed = closedRun.rows.findIndex((row) => row.state === 'closed');
    const into = closedRun.edges.filter((edge) => edge.to === closed);
    expect(into).toHaveLength(1);
    expect(into[0]!.traversed).toBe(true);
    expect(closedRun.rows[closed]!.reach).toBe('traversed');
    expect(closedRun.rows.some((row) => row.reach === 'current')).toBe(false);
    expect(closedRun.rows.filter((row) => row.reach === 'reachable')).toEqual([]);
    expectNoCollisions(closedRun);
    expect(
      layout.edges.some((edge) => layout.rows[edge.to]!.implicit),
    ).toBe(false);
  });
});

describe('layoutWorkflowGraph · any valid contract', () => {
  it('nests a fork on a branch onto its own lane', () => {
    const nested: WorkflowContract = {
      version: 1,
      name: 'nested',
      description: 'nested forks',
      roles: ['a'],
      start: 'one',
      handoffs: {
        one: { role: 'a', requires: [], on: { ok: 'two', side: 'branch' } },
        two: { role: 'a', requires: [], on: { ok: 'finish' } },
        branch: { role: 'a', requires: [], on: { left: 'deeper', right: 'other' } },
        deeper: { role: 'a', requires: [], on: { ok: 'finish' } },
        other: { role: 'a', requires: [], on: { ok: 'failed' } },
        finish: { kind: 'terminal', status: 'done' },
        failed: { kind: 'terminal', status: 'failed' },
      },
    };
    const layout = layoutWorkflowGraph(nested);
    expect(rowsOf(layout)).toEqual([
      ['one', 0, 'unreachable'],
      ['two', 0, 'unreachable'],
      ['finish', 0, 'unreachable'],
      ['branch', 1, 'unreachable'],
      ['deeper', 1, 'unreachable'],
      ['finish', 1, 'unreachable'],
      ['other', 2, 'unreachable'],
      ['failed', 2, 'unreachable'],
    ]);
    expectNoCollisions(layout);
    expectEveryBranchEndsInAState(layout, nested);
  });

  it('draws a terminal reached three ways three times', () => {
    const threeWays: WorkflowContract = {
      version: 1,
      name: 'three-ways',
      description: 'one terminal, three branches',
      roles: ['a'],
      start: 'first',
      handoffs: {
        first: { role: 'a', requires: [], on: { next: 'second', stop: 'end' } },
        second: { kind: 'gate', role: 'a', requires: [], on: { next: 'third', stop: 'end' } },
        third: { role: 'a', requires: [], on: { stop: 'end' } },
        end: { kind: 'terminal', status: 'done' },
      },
    };
    const layout = layoutWorkflowGraph(threeWays, [
      { toState: 'first' },
      { fromState: 'first', outcome: 'stop', toState: 'end' },
    ]);
    const ends = layout.rows.filter((row) => row.state === 'end');
    expect(ends).toHaveLength(3);
    expect(new Set(ends.map((row) => row.key)).size).toBe(3);
    // Only the copy this run reached is brass.
    expect(ends.map((row) => row.reach)).toEqual(['traversed', 'unreachable', 'unreachable']);
    expectNoCollisions(layout);
    expectEveryBranchEndsInAState(layout, threeWays);
  });

  it('gives overlapping loops separate lanes and a self-loop its own chevron', () => {
    const loops: WorkflowContract = {
      version: 1,
      name: 'loops',
      description: 'overlapping loops',
      roles: ['a'],
      start: 'a',
      handoffs: {
        a: { role: 'a', requires: [], on: { go: 'b' } },
        b: { kind: 'gate', role: 'a', requires: [], on: { go: 'c', again: 'b' } },
        c: {
          role: 'a',
          requires: [],
          on: { go: 'd', retry: 'a' },
          loop: { onEdge: 'retry', cap: 2, onExceeded: 'stuck' },
        },
        d: { role: 'a', requires: [], on: { go: 'done', redo: 'b' }, loop: { onEdge: 'redo', cap: 1, onExceeded: 'stuck' } },
        stuck: { kind: 'waiting' },
        done: { kind: 'terminal', status: 'done' },
      },
    };
    const layout = layoutWorkflowGraph(loops);
    const loopSpans = layout.laneSpans.filter((span) => span.column < 0);
    expect(new Set(loopSpans.map((span) => span.column)).size).toBe(3);
    expect(layout.chevrons).toHaveLength(3);
    expect(layout.rows.map((row) => row.x)[0]).toBe(10 + 18 * 3);
    expectNoCollisions(layout);
    expectEveryBranchEndsInAState(layout, loops);
  });
});

describe('workflow labels', () => {
  it('turns slugs and state names into sentence case', () => {
    expect(workflowDisplayName('feedback-triage')).toBe('Feedback triage');
    expect(workflowStateLabel('ask_human')).toBe('Ask human');
    expect(workflowStateLabel('no_code_work')).toBe('No code work');
  });
});
