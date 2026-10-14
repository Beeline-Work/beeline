import { describe, expect, it } from 'vitest';
import { deriveCornerState } from './corner-state.js';
import type { CornerStateFacts } from '@beeline/api-contract/phone';

const facts: CornerStateFacts = {
  archived: false,
  turnRunning: false,
  owed: false,
  lifecycle: { lifecycle: 'working', checks: 'unknown' },
};
describe('observed corner states', () => {
  it.each([
    ['idle', {}, 'idle'],
    ['worker running', { turnRunning: true }, 'working'],
    ['worker queued', { workerQueued: true }, 'working'],
    ['reviewer running or queued', { reviewerActive: true }, 'review'],
    ['checks running', { lifecycle: { lifecycle: 'in-review', checks: 'pending' } }, 'review'],
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
    expect(deriveCornerState({ ...facts, reviewerActive: true, owed: true })).toEqual({
      state: 'review',
    });
  });
});
