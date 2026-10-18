/** The server-owned entrypoint for the one corner state machine. Keeping the
 * pure transition in api-contract lets every server-side projection use the
 * exact same function without a package cycle. */
export {
  deriveCornerState,
  type CornerStateFacts,
  type DerivedCornerState,
} from '@beeline/api-contract/phone';

/** Existing grace period for commands a helper has not claimed. */
export const CORNER_CHECKS_BLOCKED_AFTER = '2 minutes';
