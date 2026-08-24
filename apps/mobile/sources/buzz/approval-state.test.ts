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
  it('moves from sent to landing when the daemon acknowledges the approval', () => {
    expect(
      nextApprovalState('sent', { approvalAck: { decision: 'accepted', state: 'landing' } }),
    ).toBe('landing');
  });

  it('shows that a pure rebase is landing with the existing approval', () => {
    expect(
      nextApprovalState('landing', {
        approvalAck: { decision: 'accepted', state: 'realigned' },
      }),
    ).toBe('realigning');
  });

  it('fails on a rejection ack — a stale-tip answer must reach the panel', () => {
    expect(
      nextApprovalState('sent', {
        approvalAck: { decision: 'rejected', state: 'content-changed' },
      }),
    ).toBe('failed');
  });

  it('resolves to merged on the landed delivery card', () => {
    expect(nextApprovalState('landing', { deliveryLanded: true })).toBe('merged');
  });

  it('resolves to merged when the corner archives (the pre-existing path)', () => {
    expect(nextApprovalState('landing', { archiveChannel: true })).toBe('merged');
  });

  it('fails on the delivery-failure card', () => {
    expect(nextApprovalState('landing', { deliveryFailed: true })).toBe('failed');
  });

  it('never leaves merged — a terminal outcome is sticky', () => {
    expect(nextApprovalState('merged', { deliveryFailed: true })).toBe('merged');
    expect(nextApprovalState('merged', { approvalAck: { decision: 'rejected' } })).toBe('merged');
  });

  it('reconstructs a terminal land from durable events after hydration', () => {
    expect(nextApprovalState('none', { deliveryLanded: true })).toBe('merged');
  });

  it('keeps sent when nothing relevant arrives', () => {
    expect(nextApprovalState('sent', {})).toBe('sent');
  });
});

describe('the honest timeout', () => {
  it('is generous enough for one maintenance tick plus transient relay trouble', () => {
    // The daemon consumes approvals on its maintenance poll; worst case is
    // roughly one minute. The timeout must exceed that so an ordinary,
    // healthy land never trips it.
    expect(APPROVAL_ACK_TIMEOUT_MS).toBe(60_000);
  });

  it('says what is actually known: nothing confirmed, approval not lost', () => {
    const message = approvalTimeoutMessage();
    expect(message).toMatch(/has not picked up/i);
    expect(message).toMatch(/safe/i);
    expect(message).not.toMatch(/\bfailed\b/i);
  });
});
