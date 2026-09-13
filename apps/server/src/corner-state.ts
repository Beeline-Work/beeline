/** The server-owned entrypoint for the one corner state machine. Keeping the
 * pure transition in api-contract lets every server-side projection use the
 * exact same function without a package cycle. */
export {
  deriveCornerState,
  type CornerStateFacts,
  type DerivedCornerState,
} from '@beeline/api-contract/phone';
