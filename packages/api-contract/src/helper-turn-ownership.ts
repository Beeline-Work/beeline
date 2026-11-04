/** Existing machine registration owns these controls. No public admission pass
 * is sent. Owned-row interpretation is a server protocol rollback floor even
 * with admission disabled; it is independent of native runtime 40. */
export type HelperTurnOwnershipSource = {
  readonly connectionId: string;
  readonly epoch: number;
};
export type HelperTurnOperation = 'claimAgentCommand' | 'postAgentTurnReceipt' | 'acknowledgeAgentCommand';
export const HELPER_TURN_MAX_FRAME_BYTES = 256 * 1024;
export const HELPER_TURN_MAX_INFLIGHT = 16;
export const HELPER_TURN_REQUEST_DEADLINE_MS = 30_000;
