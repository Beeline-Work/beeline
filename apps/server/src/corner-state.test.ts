import { expect, it } from 'vitest';
import { deriveCornerState } from './corner-state.js';
import type { CornerStateFacts } from '@beeline/api-contract/phone';

const facts: CornerStateFacts = { archived: false, turnRunning: false };
// Transition precedence is covered by corner-machine and the independent exhaustive/reference suites.
it.each(['landed', 'closed', 'ask_human', 'implement', 'checks', 'review'])(
  'the compatibility view ignores a historical %s lifecycle card', state => {
    expect(deriveCornerState({ ...facts, run: { state } })).toEqual({ state: 'idle' });
  },
);
it('the public waiting view preserves its selection and audience during work and CI', () => {
  const blocker = { reason: 'question' as const, itemId: 'report',
    blocker: { kind: 'report' as const, personId: 'commander', personName: 'Commander' } };
  expect(deriveCornerState({ ...facts, turnRunning: true, reviewerActive: true,
    lifecycle: { lifecycle: 'in-review', checks: 'pending' }, blocker }))
    .toEqual({ state: 'waiting', ...blocker });
});
it('the public review view omits machine phases and effect receipts', () => {
  expect(deriveCornerState({ ...facts, lifecycle: { lifecycle: 'in-review', checks: 'pending' } }))
    .toEqual({ state: 'review' });
});
