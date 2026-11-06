import type { CornerBlocker, CornerLifecycleView, CornerState, CornerStateReason } from './phone-types.js';

/** Historical observation shape retained for rolling callers. Lifecycle cards
 * are inert; only the server's corner machine decides state and dispatch. */
export type CornerRunFacts = {
  readonly state: string;
  readonly outcome?: string;
};

export type CornerStateFacts = {
  readonly archived: boolean;
  readonly locked?: boolean;
  /** Running worker receipts; reviewer work has its own input. */
  readonly turnRunning: boolean;
  readonly reviewerActive?: boolean;
  /** Inert input from older callers; the server machine does not read it. */
  readonly run?: CornerRunFacts;
  readonly lifecycle?: CornerLifecycleView;
  /**
   * The selected blocker. Merge holds are selected only when no other blocker
   * is open, so a `merge-hold` blocker means the hold is all that remains.
   */
  readonly blocker?: { readonly reason: CornerStateReason; readonly itemId?: string; readonly blocker?: CornerBlocker };
};

export type DerivedCornerState = {
  readonly state: CornerState;
  readonly reason?: CornerStateReason;
  readonly itemId?: string;
  readonly blocker?: CornerBlocker;
};
