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
    ['worker queued', { workerQueued: true }, 'working'],
    ['reviewer running or queued', { reviewerActive: true }, 'review'],
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
    expect(deriveCornerState({ ...facts, ...overrides })).toEqual({ state: expected });
  });
  it('gives worker work precedence over review and human blockers', () => {
    expect(
      deriveCornerState({ ...facts, workerQueued: true, reviewerActive: true, owed: true }),
    ).toEqual({ state: 'working' });
    const unreported = { ...pushed, checksSummary: emptySummary };
    expect(deriveCornerState({ ...facts, lifecycle: unreported, turnRunning: true })).toEqual({ state: 'working' });
    expect(deriveCornerState({ ...facts, lifecycle: unreported, owed: true })).toEqual({ state: 'waiting' });
    expect(deriveCornerState({ ...facts, reviewerActive: true, owed: true })).toEqual({
      state: 'review',
    });
  });
});
