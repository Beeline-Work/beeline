import type { CornerBlocker, CornerLifecycleView, CornerState, CornerStateReason, CornerWorkQueue } from './phone-types.js';

/**
 * Where a corner's workflow run currently sits: the `toState` of its newest
 * handoff card, and the outcome of the edge that brought it there. State names
 * are the server's corner lifecycle contract (`apps/server/src/corner-lifecycle.ts`).
 */
export type CornerRunFacts = {
  readonly state: string;
  readonly outcome?: string;
};

export type CornerStateFacts = {
  readonly archived: boolean;
  readonly locked?: boolean;
  /** Running worker receipts; reviewer work has its own input. */
  readonly turnRunning: boolean;
  /** A deliverable worker command is waiting and no live worker turn is running. */
  readonly workerQueued?: boolean;
  /** Every queued worker command is waiting on a helper with no live connection. */
  readonly workerOffline?: boolean;
  /** Another room where this worker already has a live turn, when this corner is only queued. */
  readonly queueBehind?: string;
  readonly reviewerActive?: boolean;
  /** The corner's workflow run. Absent only where no run is known; see `cornerRunFromLifecycle`. */
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
  /** Set when the corner is working because a command is still waiting to be claimed. */
  readonly queue?: CornerWorkQueue;
  /** Room name of the turn this queued worker is behind. */
  readonly queueBehind?: string;
};

/** Recover a workflow stage from persisted lifecycle facts when no run is known.
 * Locked corners retain live stages after merges; actual archival always ends them.
 * Check results select implement/review/checks without establishing activity.
 */
export function cornerRunFromLifecycle(input: {
  readonly archived: boolean;
  readonly locked?: boolean;
  readonly lifecycle?: CornerLifecycleView;
}): CornerRunFacts {
  const lifecycle = input.lifecycle;
  const rawState = String(lifecycle?.lifecycle ?? '').trim().toLowerCase();
  const merged = Boolean(lifecycle?.pr?.mergedAt) || lifecycle?.outcome === 'landed';
  if (!input.locked && merged) return { state: 'landed' };
  if (
    input.archived ||
    (!input.locked && (lifecycle?.outcome === 'abandoned' || rawState === 'done'))
  )
    return { state: 'closed' };
  if (lifecycle?.pr) {
    const checks = lifecycle.checksSummary?.status ?? lifecycle.checks;
    if (checks === 'failing') return { state: 'implement', outcome: 'failing' };
    if (checks === 'passing') return { state: 'review' };
    return { state: 'checks' };
  }
  return { state: 'implement' };
}

/**
 * Precedence, first match. Workflow stages alone do not establish activity.
 * 1. archived — actually archived, or an ended run/lifecycle on an unlocked corner.
 * 2. working — a live non-reviewer turn, or a deliverable command still waiting
 *    for that worker. The queue note says the helper is lined up, or offline.
 * 3. review — a live reviewer turn, or pending/not-yet-reported CI.
 * 4. waiting — an unresolved blocker, including reports and human merge holds.
 * 5. idle — everything else, including schedules and failing checks alone.
 */
export function deriveCornerState(facts: CornerStateFacts): DerivedCornerState {
  const ended = [facts.run?.state, cornerRunFromLifecycle(facts).state]
    .some(state => state === 'landed' || state === 'closed');
  if (facts.archived || (!facts.locked && ended))
    return { state: 'archived' };
  if (facts.turnRunning) {
    if (facts.workerQueued) {
      const queue = facts.workerOffline ? 'offline' : 'queued';
      const behind = queue === 'queued' ? facts.queueBehind?.trim() : undefined;
      return { state: 'working', queue, ...(behind ? { queueBehind: behind } : {}) };
    }
    return { state: 'working' };
  }
  const checks = facts.lifecycle?.checksSummary?.status ?? facts.lifecycle?.checks;
  if (facts.reviewerActive || checks === 'pending' ||
    facts.lifecycle?.checksSummary?.checks.some(check => check.status === 'pending') ||
    checksNotReported(facts.lifecycle))
    return { state: 'review' };
  if (facts.blocker) return { state: 'waiting', ...facts.blocker };
  return { state: 'idle' };
}

/**
 * A push resets the PR head's checks to an empty `unknown` summary with no
 * fetch time. Until GitHub reports on that head, its checks are under way.
 * An empty summary from a completed fetch means no checks are configured.
 */
function checksNotReported(lifecycle: CornerLifecycleView | undefined): boolean {
  const summary = lifecycle?.checksSummary;
  return Boolean(lifecycle?.pr) && summary?.status === 'unknown' && summary.total === 0 &&
    summary.fetchStartedAt === undefined;
}
