import type { WorkflowHandoffState, WorkflowTerminalState, WorkflowLoop } from './workflow-contracts.js';

/** Static server-owned lifecycle schema; never a saved workflow. */
export type CornerLifecycleContract = {
  readonly version: 1;
  readonly name: string;
  readonly description: string;
  readonly summary?: string;
  readonly roles: readonly string[];
  readonly start: string;
  readonly handoffs: Readonly<Record<string, CornerLifecycleState>>;
  /**
   * Terminal state names reachable from ANY non-terminal state at any time,
   * independent of graph position — a merge webhook or a human close request
   * doesn't wait for a run to be "at" a particular state. Each named state
   * must itself be `kind:'terminal'`.
   */
  readonly implicitEdges?: readonly string[];
  /**
   * Outcome names that only an event from outside the run can report — for
   * the corner, a new commit landing on its branch or GitHub refusing a merge.
   * The run cannot reach such an edge again on its own, so cycle detection
   * ignores edges with these outcomes. Each must be an outcome some state
   * declares.
   */
  readonly externalOutcomes?: readonly string[];
};
export type CornerLifecycleState =
  | (WorkflowHandoffState & { readonly roleBinding?: string })
  | CornerServerState | CornerWaitingState | WorkflowTerminalState;

/** Only the server moves this state; a role is advisory. */
export type CornerServerState = {
  /** A short sentence for people reading the run. Optional on legacy revisions. */
  readonly does?: string;
  readonly hint?: string;
  readonly kind: 'server';
  readonly role?: string;
  readonly requires: readonly string[];
  readonly on: Readonly<Record<string, string>>;
  readonly loop?: WorkflowLoop;
};

/** A parked state moved only by an outside event. */
export type CornerWaitingState = {
  /** A short sentence for people reading the run. Optional on legacy revisions. */
  readonly does?: string;
  readonly hint?: string;
  readonly kind: 'waiting';
  /** Advisory only, exactly like `CornerServerState.role` — who is conceptually active here. */
  readonly role?: string;
};
