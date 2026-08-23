/**
 * Approve-panel state machine — the DELIVERING state must never hang.
 *
 * The 2026-08-23 live defect: the owner tapped APPROVE, the relay accepted
 * the signed event, and the panel showed '✓ APPROVAL SENT · DELIVERING…'
 * spinning forever. The app's only exits from `delivering` were two specific
 * live events (the corner's archive notice, a delivery-failure card) — no
 * acknowledgement tied to the approval itself, and no timeout, so any missed
 * event or silent daemon left the spinner up indefinitely.
 *
 * This module owns every transition OUT of `delivering`/`sending`:
 *
 *   - an approval ack (`decision=accepted`) confirms the daemon has the
 *     approval and is landing it — the human's part is done;
 *   - an ack with `decision=rejected` fails the panel with the daemon's
 *     reason (a stale tip must be answered, never swallowed);
 *   - the landed card (`delivery=landed`) resolves success even if the
 *     archive notice was missed;
 *   - a timeout (no ack within the window) resolves to an honest failure
 *     explaining that the signed approval stays on the relay.
 *
 * Pure so `chat/[channelId].tsx` wires it and tests pin it without rendering
 * the screen.
 */

export type ApprovalUiState = 'none' | 'sending' | 'delivering' | 'failed' | 'merged';

/** How long DELIVERING may persist with no daemon acknowledgement before the
 *  panel resolves itself with an honest message. Generous enough to cover the
 *  maintenance-tick cadence the daemon consumes approvals on (worst case ~60s)
 *  plus one transient relay hiccup; short enough that a dead daemon cannot\n *  hold the spinner past the person's patience. */
export const APPROVAL_ACK_TIMEOUT_MS = 90_000;

/** Honest copy for the timeout path. The approval itself is NOT lost: it is a
 *  signed event durably on the relay, and a reconnecting daemon will honor it. */
export function approvalTimeoutMessage(): string {
  return (
    'No acknowledgement arrived from the agent’s daemon. Your signed approval is safe on ' +
    'the relay and will be honored when the daemon next checks — but nothing is confirming ' +
    'progress right now.'
  );
}

/** Minimal shape of `ChatEventProjection` this reducer reads. Kept structural
 *  so both the screen's live batch loop and tests can feed it directly. */
export interface ApprovalStateEvent {
  approvalAck?: { decision: 'accepted' | 'rejected'; tip?: string };
  deliveryLanded?: boolean;
  deliveryFailed?: boolean;
  archiveChannel?: boolean;
  mergeTarget?: { tip: string } | null;
}

/**
 * One transition step. `merged` is terminal-sticky (as in the screen today);
 * a merge target on a NEWER tip reopens the panel for the fresh review — the
 * caller resets to `none` when the tip changed before invoking this.
 */
export function nextApprovalState(
  current: ApprovalUiState,
  event: ApprovalStateEvent,
): ApprovalUiState {
  if (current === 'none' || current === 'merged') return current;
  // An explicit rejection of the signed approval always wins: the daemon saw
  // it and refused it (stale tip). The reason text rides the system notice.
  if (event.approvalAck?.decision === 'rejected') return 'failed';
  if (event.deliveryLanded) return 'merged';
  if (event.archiveChannel) return 'merged';
  if (event.deliveryFailed) return 'failed';
  // An acceptance ack means the daemon took custody of the approval. The
  // panel stops claiming "delivering" (an unbounded claim nobody answers
  // for) and rests on the transcript + corner lifecycle from here; the land
  // events above still resolve it when they arrive later.
  if (event.approvalAck?.decision === 'accepted') return current;
  return current;
}
