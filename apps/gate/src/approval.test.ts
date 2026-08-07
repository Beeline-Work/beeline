import { describe, it, expect } from 'vitest';
import { newIdentity } from './identity.js';
import { buildApproval, verifyApproval, type MergeTarget } from './approval.js';

const reviewer = newIdentity('reviewer');
const attacker = newIdentity('attacker');
const channel = '11111111-1111-1111-1111-111111111111';
const target: MergeTarget = {
  repo: `${reviewer.publicKey}/demo`,
  branch: 'refs/heads/main',
  tip: 'a'.repeat(40),
};

describe('verifyApproval — the exact-binding gate', () => {
  it('accepts a valid reviewer approval bound to the exact target', () => {
    const ev = buildApproval(reviewer, channel, target);
    expect(verifyApproval(ev, reviewer.publicKey, target)).toBe(true);
  });

  it('rejects a forged approval signed by someone other than the reviewer', () => {
    const ev = buildApproval(attacker, channel, target);
    expect(verifyApproval(ev, reviewer.publicKey, target)).toBe(false);
  });

  it('rejects a tampered signature (content mutated after signing)', () => {
    const ev = { ...buildApproval(reviewer, channel, target), content: 'APPROVE everything' };
    expect(verifyApproval(ev, reviewer.publicKey, target)).toBe(false);
  });

  it('rejects a grant bound to a different tip (replay onto another merge)', () => {
    const ev = buildApproval(reviewer, channel, { ...target, tip: 'b'.repeat(40) });
    expect(verifyApproval(ev, reviewer.publicKey, target)).toBe(false);
  });

  it('rejects a grant bound to a different branch', () => {
    const ev = buildApproval(reviewer, channel, { ...target, branch: 'refs/heads/release' });
    expect(verifyApproval(ev, reviewer.publicKey, target)).toBe(false);
  });

  it('rejects a grant bound to a different repo', () => {
    const ev = buildApproval(reviewer, channel, { ...target, repo: `${attacker.publicKey}/demo` });
    expect(verifyApproval(ev, reviewer.publicKey, target)).toBe(false);
  });
});
