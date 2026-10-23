import { describe, expect, it } from 'vitest';
import { approvalDecisionNote } from './approval-decision-copy';

describe('approval decision attribution', () => {
  const human = { pubkey: 'human', kind: 'human' as const, name: 'Lunchbox', handle: 'lunchboxfortwo' };
  it('uses you only for the verified decision-maker viewing their own decision', () => {
    expect(approvalDecisionNote('allowed', human, 1700000000, 'human')).toContain('Allowed by you ·');
    expect(approvalDecisionNote('denied', human, 1700000000, 'other')).toContain('Denied by @lunchboxfortwo ·');
  });
  it('keeps absent attribution neutral and expiry distinct from denial', () => {
    expect(approvalDecisionNote('approved', undefined, 1700000000, 'human')).toMatch(/^Allowed ·/);
    expect(approvalDecisionNote('denied', undefined, 1700000000, 'human')).toMatch(/^Denied ·/);
    expect(approvalDecisionNote('expired', undefined, 1700000000, 'human', 'edit a key')).toMatch(/^The request to edit a key expired ·/);
  });
});
