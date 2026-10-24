import { describe, expect, it } from 'vitest';
import { deriveCornerState } from './corner-state.js';
import type { CornerStateFacts } from '@beeline/api-contract/phone';

const facts: CornerStateFacts = {
  archived: false,
  turnRunning: false,
  owed: false,
  now: 1000,
  ciStartedAt: 990,
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
      { lifecycle: { lifecycle: 'in-review', checks: 'failing' }, ciStartedAt: undefined },
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

it.each([[10,'working'],[40,'idle']])('turn ended %s seconds ago', (age,state) => {
  expect(deriveCornerState({...facts,lastTurnEndedAt:1000-Number(age)}).state).toBe(state);
});
it('failing checks past the repair window are idle', () => {
  expect(deriveCornerState({
    ...facts,
    ciStartedAt: 1000 - 1801,
    lifecycle: { lifecycle: 'in-review', checks: 'failing' },
  })).toEqual({ state: 'idle' });
});
it('a repair turn still running past 30 minutes without a push is idle', () => {
  expect(deriveCornerState({
    ...facts,
    turnRunning: true,
    ciStartedAt: 1000 - 1801,
    lifecycle: { lifecycle: 'in-review', checks: 'failing' },
  })).toEqual({ state: 'idle' });
  expect(deriveCornerState({
    ...facts,
    turnRunning: true,
    lifecycle: { lifecycle: 'in-review', checks: 'failing' },
  }).state).toBe('working');
});
it('checks pending for 45 minutes, with no blocker and no turn running, stay review', () => {
  expect(deriveCornerState({
    ...facts,
    owed: false,
    turnRunning: false,
    ciStartedAt: 1000 - 45 * 60,
    lifecycle: { lifecycle: 'in-review', checks: 'pending' },
  })).toEqual({ state: 'review' });
});
it('a fresh failing repair window is working', () => {
  expect(deriveCornerState({
    ...facts,
    lifecycle: { lifecycle: 'in-review', checks: 'failing' },
  }).state).toBe('working');
});
it('a blocked report while checks are pending or unreported is idle', () => {
  const unreported = {
    lifecycle: 'in-review' as const,
    checks: 'unknown' as const,
    pr: { number: 1, url: 'https://github.com/o/r/pull/1', title: 'Fix', targetBranch: 'main', headSha: '2'.repeat(40) },
    checksSummary: { status: 'unknown' as const, total: 0, failing: [], checks: [], updatedAt: 1 },
  };
  expect(deriveCornerState({
    ...facts,
    stallReport: true,
    owed: true,
    agentCommanderReport: true,
    lifecycle: { lifecycle: 'in-review', checks: 'pending' },
  }).state).toBe('idle');
  expect(deriveCornerState({
    ...facts,
    stallReport: true,
    owed: true,
    agentCommanderReport: true,
    lifecycle: unreported,
  }).state).toBe('idle');
});
it('a blocked report during a fresh failing repair window stays working', () => {
  expect(deriveCornerState({
    ...facts,
    stallReport: true,
    owed: true,
    agentCommanderReport: true,
    lifecycle: { lifecycle: 'in-review', checks: 'failing' },
  }).state).toBe('working');
});
it('a running reviewer does not keep a red head in review', () => {
  expect(deriveCornerState({
    ...facts,
    reviewerActive: true,
    ciStartedAt: undefined,
    lifecycle: { lifecycle: 'in-review', checks: 'failing' },
  }).state).toBe('idle');
});
it.each([
  ['pending', 'review'],
  ['failing', 'idle'],
] as const)('CI %s past 30 minutes is %s', (checks, state) => {
  expect(deriveCornerState({...facts,ciStartedAt:1000-1801,lifecycle:{lifecycle:'in-review',checks}})).toEqual({state});
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
    ...facts, owed: true, lifecycle: pending,
    blocker: { reason: 'approve', blocker: { kind: 'merge-hold', personId: 'human' } },
  })).toEqual({
    state: 'waiting', reason: 'approve', blocker: { kind: 'merge-hold', personId: 'human' },
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
    ...facts, owed: true, agentCommanderReport: true, ciStartedAt: 1000 - 1801,
    lifecycle: pending, blocker: agentReport,
  })).toEqual({ state: 'review' });
});
