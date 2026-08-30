import { describe, it, expect } from 'vitest';
import { createIdentity } from './identity.js';
import {
  buildMergeApproval,
  buildMergeRejection,
  verifyMergeApproval,
  verifyMergeRejection,
} from './approval.js';
import { KIND_STREAM_MESSAGE, TAG_MERGE_APPROVAL } from './kinds.js';
import { tagValue } from './parse.js';

const reviewer = createIdentity('reviewer');
const attacker = createIdentity('attacker');
const channel = '11111111-1111-1111-1111-111111111111';
const target = {
  repo: `${reviewer.publicKey}/demo`,
  branch: 'refs/heads/main',
  tip: 'a'.repeat(40),
};

describe('buildMergeApproval / verifyMergeApproval', () => {
  it('builds kind:9 with gate-compatible tags', () => {
    const ev = buildMergeApproval(reviewer, channel, target);
    expect(ev.kind).toBe(KIND_STREAM_MESSAGE);
    expect(tagValue(ev, 'h')).toBe(channel);
    expect(tagValue(ev, 't')).toBe(TAG_MERGE_APPROVAL);
    expect(tagValue(ev, 'repo')).toBe(target.repo);
    expect(tagValue(ev, 'branch')).toBe(target.branch);
    expect(tagValue(ev, 'tip')).toBe(target.tip);
    expect(ev.pubkey).toBe(reviewer.publicKey);
    expect(ev.id).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.sig).toMatch(/^[0-9a-f]{128}$/);
  });

  it('accepts a valid reviewer approval bound to the exact target', () => {
    const ev = buildMergeApproval(reviewer, channel, target);
    expect(verifyMergeApproval(ev, reviewer.publicKey, target, channel)).toBe(true);
  });

  it('rejects a forged approval signed by someone other than the reviewer', () => {
    const ev = buildMergeApproval(attacker, channel, target);
    expect(verifyMergeApproval(ev, reviewer.publicKey, target, channel)).toBe(false);
  });

  it('rejects a tampered signature (content mutated after signing)', () => {
    const ev = { ...buildMergeApproval(reviewer, channel, target), content: 'APPROVE everything' };
    expect(verifyMergeApproval(ev, reviewer.publicKey, target, channel)).toBe(false);
  });

  it('keeps the corner approval valid when ongoing work advances the tip', () => {
    const ev = buildMergeApproval(reviewer, channel, { ...target, tip: 'b'.repeat(40) });
    expect(verifyMergeApproval(ev, reviewer.publicKey, target, channel)).toBe(true);
  });

  it('keeps the corner approval valid across a pure rebase', () => {
    const patchId = 'c'.repeat(40);
    const ev = buildMergeApproval(reviewer, channel, { ...target, patchId });
    expect(
      verifyMergeApproval(
        ev,
        reviewer.publicKey,
        {
          ...target,
          tip: 'b'.repeat(40),
          patchId,
        },
        channel,
      ),
    ).toBe(true);
  });

  it('keeps approval standing when ongoing work changes the reviewed diff', () => {
    const ev = buildMergeApproval(reviewer, channel, { ...target, patchId: 'c'.repeat(40) });
    expect(
      verifyMergeApproval(
        ev,
        reviewer.publicKey,
        {
          ...target,
          tip: 'b'.repeat(40),
          patchId: 'd'.repeat(40),
        },
        channel,
      ),
    ).toBe(true);
  });

  it('keeps legacy approvals standing for the same corner', () => {
    const ev = buildMergeApproval(reviewer, channel, target);
    expect(
      verifyMergeApproval(
        ev,
        reviewer.publicKey,
        {
          ...target,
          tip: 'b'.repeat(40),
          patchId: 'c'.repeat(40),
        },
        channel,
      ),
    ).toBe(true);
  });

  it('rejects an otherwise matching approval from a different corner', () => {
    const ev = buildMergeApproval(reviewer, 'corner-other', target);
    expect(verifyMergeApproval(ev, reviewer.publicKey, target, channel)).toBe(false);
  });

  it('rejects a grant bound to a different branch', () => {
    const ev = buildMergeApproval(reviewer, channel, {
      ...target,
      branch: 'refs/heads/release',
    });
    expect(verifyMergeApproval(ev, reviewer.publicKey, target, channel)).toBe(false);
  });

  it('rejects a grant bound to a different repo', () => {
    const ev = buildMergeApproval(reviewer, channel, {
      ...target,
      repo: `${attacker.publicKey}/demo`,
    });
    expect(verifyMergeApproval(ev, reviewer.publicKey, target, channel)).toBe(false);
  });
});

describe('buildMergeRejection / verifyMergeRejection', () => {
  it('uses the approval binding with a distinct mutually-exclusive verdict marker', () => {
    const rejectedTarget = { repo: 'owner/repo', branch: 'refs/heads/main', tip: 'a'.repeat(40) };
    const event = buildMergeRejection(reviewer, 'corner-id', rejectedTarget);
    expect(verifyMergeRejection(event, reviewer.publicKey, rejectedTarget, 'corner-id')).toBe(true);
    expect(verifyMergeApproval(event, reviewer.publicKey, rejectedTarget, 'corner-id')).toBe(false);
  });
});
