/**
 * Approve-panel state machine (`approval-state.ts`).
 *
 * Pins the contract that an approval can never hang silently: every exit
 * from DELIVERING is evidence-based (ack, landed card, failure card,
 * archive) or time-based (the honest timeout message).
 */
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_ACK_TIMEOUT_MS,
  approvalTimeoutMessage,
  nextApprovalState,
} from './approval-state';

describe('nextApprovalState', () => {
  it('stays in delivering on an acceptance ack — the ack narrows the claim, the land resolves it', () => {
    expect(
      nextApprovalState('delivering', { approvalAck: { decision: 'accepted' } }),
    ).toBe('delivering');
  });

  it('fails on a rejection ack — a stale-tip answer must reach the panel', () => {
    expect(
      nextApprovalState('delivering', { approvalAck: { decision: 'rejected' } }),
    ).toBe('failed');
  });

  it('resolves to merged on the landed delivery card', () => {
    expect(nextApprovalState('delivering', { deliveryLanded: true })).toBe('merged');
  });

  it('resolves to merged when the corner archives (the pre-existing path)', () => {
    expect(nextApprovalState('delivering', { archiveChannel: true })).toBe('merged');
  });

  it('fails on the delivery-failure card', () => {
    expect(nextApprovalState('delivering', { deliveryFailed: true })).toBe('failed');
  });

  it('never leaves merged — a terminal outcome is sticky', () => {
    expect(nextApprovalState('merged', { deliveryFailed: true })).toBe('merged');
    expect(nextApprovalState('merged', { approvalAck: { decision: 'rejected' } })).toBe('merged');
  });

  it('does nothing from none — no panel is open', () => {
    expect(nextApprovalState('none', { deliveryLanded: true })).toBe('none');
  });

  it('keeps delivering when nothing relevant arrives', () => {
    expect(nextApprovalState('delivering', {})).toBe('delivering');
  });
});

describe('the honest timeout', () => {
  it('is generous enough for one maintenance tick plus transient relay trouble', () => {
    // The daemon consumes approvals on its maintenance poll; worst case is
    // roughly one minute. The timeout must exceed that so an ordinary,
    // healthy land never trips it.
    expect(APPROVAL_ACK_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });

  it('says what is actually known: nothing confirmed, approval not lost', () => {
    const message = approvalTimeoutMessage();
    expect(message).toMatch(/No acknowledgement/i);
    expect(message).toMatch(/safe on/);
    expect(message).not.toMatch(/\bfailed\b/i);
  });
});
