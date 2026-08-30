/**
 * Ephemeral approval-submit UI only. Durable lifecycle is server-owned and
 * arrives through RoomView.cornerLifecycle; this file never interprets relay
 * messages, archive cards, or merge receipts as product state.
 */

export type ApprovalUiState =
  | 'none'
  | 'sending'
  | 'sent'
  | 'landing'
  | 'realigning'
  | 'failed'
  | 'timeout'
  | 'merged';

/** How long SENT may persist with no daemon acknowledgement before the panel
 *  states that the agent may be offline. The durable approval keeps standing
 *  and a recovered daemon still honors it automatically. */
export const APPROVAL_ACK_TIMEOUT_MS = 60_000;

/** Honest copy for the timeout path. The approval itself is NOT lost: it is a
 *  signed event durably on the relay, and a reconnecting daemon will honor it. */
export function approvalTimeoutMessage(): string {
  return (
    'The agent has not picked up your approval yet (offline?). Your signed approval is safe ' +
    'and will be honored automatically when the daemon recovers.'
  );
}
