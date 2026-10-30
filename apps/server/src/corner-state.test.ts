import { describe, expect, it } from 'vitest';
import { deriveCornerState } from './corner-state.js';
import type { CornerStateFacts } from '@beeline/api-contract/phone';

const facts: CornerStateFacts = {
  archived: false,
  turnRunning: false,
  owed: false,
  lifecycle: { lifecycle: 'working', checks: 'unknown' },
};
const pushed = {
  lifecycle: 'in-review',
  checks: 'unknown',
  pr: { number: 1, url: 'https://github.com/o/r/pull/1', title: 'Fix', targetBranch: 'main', headSha: '2'.repeat(40) },
} as const;
const emptySummary = { status: 'unknown', total: 0, failing: [], checks: [], updatedAt: 1 } as const;
describe('observed corner states', () => {
  it.each([
    ['idle', {}, 'idle'],
    ['worker running', { turnRunning: true }, 'working'],
    ['worker queued alone', { workerQueued: true }, 'idle'],
    ['reviewer running', { reviewerActive: true }, 'review'],
    ['queued for merge', { lifecycle: { ...pushed, checks: 'passing', mergeQueue: { headSha: pushed.pr.headSha } } }, 'idle'],
    ['checks running', { lifecycle: { lifecycle: 'in-review', checks: 'pending' } }, 'review'],
    [
      'pushed head before checks report',
      { lifecycle: { ...pushed, checksSummary: { ...emptySummary } } },
      'review',
    ],
    [
      'pushed head with pending checks',
      { lifecycle: { ...pushed, checks: 'pending', checksSummary: { ...emptySummary, status: 'pending' } } },
      'review',
    ],
    [
      'fetch found no checks configured',
      { lifecycle: { ...pushed, checksSummary: { ...emptySummary, fetchStartedAt: 1 } } },
      'idle',
    ],
    ['empty summary without a PR', { lifecycle: { ...pushed, pr: undefined, checksSummary: emptySummary } }, 'idle'],
    [
      'merged PR with an unreported head',
      { lifecycle: { ...pushed, pr: { ...pushed.pr, mergedAt: '2026-10-20T00:00:00Z' }, checksSummary: emptySummary } },
      'archived',
    ],
    [
      'checks done without reviewer',
      { lifecycle: { lifecycle: 'in-review', checks: 'passing' } },
      'idle',
    ],
    [
      'checks failed without worker',
      { lifecycle: { lifecycle: 'in-review', checks: 'failing' } },
      'idle',
    ],
    ['human merge yes', { owed: true, lifecycle: { ...pushed, checks: 'passing' } }, 'waiting'],
    ['unanswered human request', { owed: true }, 'waiting'],
    ['legacy ask stage alone', { run: { state: 'ask_human' } }, 'idle'],
    ['failed turn alone', { run: { state: 'implement', outcome: 'failed' } }, 'idle'],
    ['finished reviewer', { run: { state: 'review' } }, 'idle'],
    ['archived', { archived: true, turnRunning: true }, 'archived'],
    [
      'merged',
      { lifecycle: { lifecycle: 'done', checks: 'passing', outcome: 'landed' } },
      'archived',
    ],
    ['closed run', { run: { state: 'closed' } }, 'archived'],
  ] as const)('%s', (_name, overrides, expected) => {
    expect(deriveCornerState({ ...facts, ...overrides })).toMatchObject({ state: expected });
  });
  it('gives live review precedence and active turns precedence over blockers', () => {
    expect(
      deriveCornerState({ ...facts, workerQueued: true, reviewerActive: true, owed: true }),
    ).toEqual({ state: 'review' });
    const unreported = { ...pushed, checksSummary: emptySummary };
    expect(deriveCornerState({ ...facts, lifecycle: unreported, turnRunning: true })).toEqual({ state: 'working' });
    expect(deriveCornerState({ ...facts, lifecycle: unreported, owed: true })).toEqual({ state: 'waiting' });
    expect(deriveCornerState({ ...facts, reviewerActive: true, owed: true })).toEqual({
      state: 'review',
    });
  });
});

it('Reproduction R1: a turn that just ended without a report is idle, not working', () => {
  expect(deriveCornerState(facts).state).toBe('idle');
});
it('FIC-1: a live implementer stays working regardless of failing-check age', () => {
  expect(deriveCornerState({ ...facts, turnRunning: true,
    lifecycle: { lifecycle: 'in-review', checks: 'failing' } }).state).toBe('working');
});
it('failing checks without a turn or blocker fall through to idle', () => {
  expect(deriveCornerState({ ...facts,
    lifecycle: { lifecycle: 'in-review', checks: 'failing' } }).state).toBe('idle');
});
it('FIC-1: a blocked report while checks are pending or unreported stays review', () => {
  const unreported = {
    lifecycle: 'in-review' as const,
    checks: 'unknown' as const,
    pr: { number: 1, url: 'https://github.com/o/r/pull/1', title: 'Fix', targetBranch: 'main', headSha: '2'.repeat(40) },
    checksSummary: { status: 'unknown' as const, total: 0, failing: [], checks: [], updatedAt: 1 },
  };
  expect(deriveCornerState({
    ...facts,
    owed: true,
    agentCommanderReport: true,
    lifecycle: { lifecycle: 'in-review', checks: 'pending' },
  }).state).toBe('review');
  expect(deriveCornerState({
    ...facts,
    owed: true,
    agentCommanderReport: true,
    lifecycle: unreported,
  }).state).toBe('review');
});
it('a blocked report with failing checks waits for the commander', () => {
  expect(deriveCornerState({
    ...facts,
    owed: true,
    agentCommanderReport: true,
    lifecycle: { lifecycle: 'in-review', checks: 'failing' },
  }).state).toBe('waiting');
});
it('a running reviewer does not keep a red head in review', () => {
  expect(deriveCornerState({
    ...facts,
    reviewerActive: true,
    lifecycle: { lifecycle: 'in-review', checks: 'failing' },
  }).state).toBe('idle');
});
it.each([
  ['pending', 'review'],
  ['failing', 'idle'],
] as const)('CI %s without work or a blocker is %s', (checks, state) => {
  expect(deriveCornerState({...facts,lifecycle:{lifecycle:'in-review',checks}})).toEqual({state});
});

it('Reproduction R1: an agent-commander report stays review while checks run, and a human blocker stays waiting', () => {
  const pending = { lifecycle: 'in-review' as const, checks: 'pending' as const };
  const agentReport = {
    reason: 'question' as const,
    blocker: { kind: 'report' as const, personId: 'commander' },
  };
  const unreported = { ...pushed, checksSummary: emptySummary };
  expect(deriveCornerState({
    ...facts, owed: true, agentCommanderReport: true, lifecycle: pending, blocker: agentReport,
  })).toEqual({ state: 'review' });
  expect(deriveCornerState({
    ...facts, owed: true, agentCommanderReport: true, lifecycle: unreported, blocker: agentReport,
  })).toEqual({ state: 'review' });
  expect(deriveCornerState({
    ...facts, owed: true, lifecycle: pending,
    blocker: { reason: 'question', blocker: { kind: 'report', personId: 'human' } },
  })).toEqual({
    state: 'waiting', reason: 'question', blocker: { kind: 'report', personId: 'human' },
  });
  expect(deriveCornerState({
    ...facts, owed: true, agentCommanderReport: true,
    lifecycle: { lifecycle: 'in-review', checks: 'passing' }, blocker: agentReport,
  })).toEqual({ state: 'waiting', ...agentReport });
  expect(deriveCornerState({
    ...facts, owed: true, agentCommanderReport: true,
    lifecycle: { lifecycle: 'in-review', checks: 'failing' }, blocker: agentReport,
  })).toEqual({ state: 'waiting', ...agentReport });
  expect(deriveCornerState({
    ...facts, owed: true, agentCommanderReport: true,
    lifecycle: pending, blocker: agentReport,
  })).toEqual({ state: 'review' });
});

describe('Reproduction R1: a merge hold blocks only the merge', () => {
  const hold = { reason: 'approve' as const, blocker: { kind: 'merge-hold' as const, personId: 'human' } };
  const held = { ...facts, owed: true, blocker: hold };
  it.each([
    ['checks pending', 'review', { lifecycle: { lifecycle: 'in-review', checks: 'pending' } }],
    ['checks not yet reported after a push', 'review', { lifecycle: { ...pushed, checksSummary: emptySummary } }],
    ['a reviewer turn running', 'review', { reviewerActive: true, lifecycle: { ...pushed, checks: 'passing' } }],
    ['a worker turn running', 'working', { turnRunning: true, lifecycle: { lifecycle: 'in-review', checks: 'pending' } }],
  ] as const)('a held corner with %s is %s', (_name, state, extra) => {
    expect(deriveCornerState({ ...held, ...extra })).toEqual({ state });
  });
  it.each(['passing', 'failing'] as const)('a held corner with %s checks waits on the hold', (checks) => {
    expect(deriveCornerState({ ...held, lifecycle: { ...pushed, checks } }))
      .toEqual({ state: 'waiting', ...hold });
  });
  it('a held corner without a pull request waits on the hold', () => {
    expect(deriveCornerState(held)).toEqual({ state: 'waiting', ...hold });
  });
  it('a held corner with a human question still waits on the question while checks run', () => {
    const question = { reason: 'question' as const, blocker: { kind: 'message' as const, personId: 'human' } };
    expect(deriveCornerState({
      ...held, blocker: question, lifecycle: { lifecycle: 'in-review', checks: 'pending' },
    })).toEqual({ state: 'waiting', ...question });
  });
});
