import { describe, expect, it } from 'vitest';
import type { CornerLifecycleView } from '@beeline/api-contract/phone';
import { deriveCornerState } from './corner-state.js';

const lifecycle = (
  overrides: Partial<CornerLifecycleView> = {},
): CornerLifecycleView => ({ lifecycle: 'unknown', checks: 'unknown', ...overrides });

describe('deriveCornerState', () => {
  it.each([
    ['freshly opened', false, false, lifecycle(), { state: 'waiting' }],
    ['legacy open', false, false, lifecycle({ lifecycle: 'open' as never }), { state: 'waiting' }],
    ['idle', false, false, lifecycle({ lifecycle: 'working' }), { state: 'waiting' }],
    ['legacy idle', false, false, lifecycle({ lifecycle: 'idle' as never }), { state: 'waiting' }],
    ['question', false, false, lifecycle({ reason: 'question' }), { state: 'waiting', reason: 'question' }],
    ['failure', false, false, lifecycle({ reason: 'failure' }), { state: 'waiting', reason: 'failed' }],
    ['legacy failure state', false, false, lifecycle({ lifecycle: 'failure' as never }), { state: 'waiting', reason: 'failed' }],
    ['running', false, true, lifecycle(), { state: 'working' }],
    ['running with PR', false, true, lifecycle({ pr: { number: 1, url: 'https://example.test/pr/1', title: 'PR', targetBranch: 'main', headSha: 'a' } }), { state: 'working' }],
    ['PR pending', false, false, lifecycle({ checks: 'pending', pr: { number: 1, url: 'https://example.test/pr/1', title: 'PR', targetBranch: 'main', headSha: 'a' } }), { state: 'review' }],
    ['PR passing', false, false, lifecycle({ checks: 'passing', pr: { number: 1, url: 'https://example.test/pr/1', title: 'PR', targetBranch: 'main', headSha: 'a' } }), { state: 'review' }],
    ['PR failing', false, false, lifecycle({ checks: 'failing', pr: { number: 1, url: 'https://example.test/pr/1', title: 'PR', targetBranch: 'main', headSha: 'a' } }), { state: 'review', reason: 'checks-failed' }],
    ['archived row', true, true, lifecycle(), { state: 'archived' }],
    ['done', false, true, lifecycle({ lifecycle: 'done' }), { state: 'archived' }],
    ['merged PR', false, true, lifecycle({ lifecycle: 'in-review', outcome: 'landed', pr: { number: 1, url: 'https://example.test/pr/1', title: 'PR', targetBranch: 'main', headSha: 'a' } }), { state: 'archived' }],
    ['abandoned', false, true, lifecycle({ outcome: 'abandoned' }), { state: 'archived' }],
    ['legacy concluded', false, true, lifecycle({ lifecycle: 'concluded' as never }), { state: 'archived' }],
    ['legacy closed', false, true, lifecycle({ lifecycle: 'closed' as never }), { state: 'archived' }],
    ['legacy cleaned', false, true, lifecycle({ lifecycle: 'cleaned' as never }), { state: 'archived' }],
  ] as const)('%s', (_name, archived, turnRunning, facts, expected) => {
    expect(deriveCornerState({ archived, turnRunning, lifecycle: facts })).toEqual(expected);
  });
});
