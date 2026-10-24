import type { CornerBlocker, CornerLifecycleView, CornerState, CornerStateReason } from './phone-types.js';

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
  /** Running worker receipts; reviewer work has its own input. */
  readonly turnRunning: boolean;
  readonly workerQueued?: boolean;
  readonly now?: number;
  readonly lastTurnEndedAt?: number;
  /** When this head was first seen pending. It does not end review. */
  readonly ciStartedAt?: number;
  readonly reviewerActive?: boolean;
  /** The corner's workflow run. Absent only where no run is known; see `cornerRunFromLifecycle`. */
  readonly run?: CornerRunFacts;
  readonly lifecycle?: CornerLifecycleView;
  /**
   * Whether an unresolved blocker is present. Who it is owed to is
   * `agentCommanderReport`. A workflow stage or an ordinary tag alone never
   * establishes a blocker.
   */
  readonly owed?: boolean;
  /**
   * Every unresolved blocker is a blocked or needs-decision report to the
   * agent commander, taken from that report's recipient. Pending checks on
   * the current head stay review until a final result or a new push. A
   * human-owed blocker leaves this unset, including when an agent-commander
   * report is also open.
   */
  readonly agentCommanderReport?: boolean;
  readonly blocker?: { readonly reason: CornerStateReason; readonly itemId?: string; readonly blocker?: CornerBlocker };
};

export type DerivedCornerState = {
  readonly state: CornerState;
  readonly reason?: CornerStateReason;
  readonly itemId?: string;
  readonly blocker?: CornerBlocker;
};

/**
 * Recover the workflow stage when no handoff card records one. Displayed state
 * uses live work and human blockers separately; a stage alone is not activity.
 *
 * - ended (archived, merged, done, abandoned) -> `landed` or `closed`
 * - a PR with failing checks -> `implement`, reached by `failing`
 * - a PR with passing checks -> `review`
 * - a PR with pending or unknown checks -> `checks`
 * - a question waiting on a person -> `ask_human`
 * - a failed turn -> `implement`, reached by `failed` (no contract edge)
 * - anything else -> `implement`
 */
export function cornerRunFromLifecycle(input: {
  readonly archived: boolean;
  readonly lifecycle?: CornerLifecycleView;
}): CornerRunFacts {
  const lifecycle = input.lifecycle;
  const rawState = String(lifecycle?.lifecycle ?? '').trim().toLowerCase();
  const merged = Boolean(lifecycle?.pr?.mergedAt) || lifecycle?.outcome === 'landed';
  if (merged || rawState === 'merged') return { state: 'landed' };
  if (
    input.archived ||
    lifecycle?.outcome === 'abandoned' ||
    ['done', 'concluded', 'closed', 'abandoned', 'cleaned'].includes(rawState)
  )
    return { state: 'closed' };
  if (lifecycle?.pr) {
    const checks = lifecycle.checksSummary?.status ?? lifecycle.checks;
    if (checks === 'failing') return { state: 'implement', outcome: 'failing' };
    if (checks === 'passing') return { state: 'review' };
    return { state: 'checks' };
  }
  const rawReason = lifecycle?.reason?.trim().toLowerCase();
  if (rawReason === 'question' || rawState === 'question') return { state: 'ask_human' };
  if (['failure', 'failed'].includes(rawReason ?? '') || ['failure', 'failed'].includes(rawState))
    return { state: 'implement', outcome: 'failed' };
  return { state: 'implement' };
}

/**
 * Precedence, first match. Workflow stages do not add activity of their own.
 *
 * 1. `archived` — the corner is archived, or its run or lifecycle is landed or closed.
 * 2. `review` — a reviewer turn is active.
 * 3. `working` — a worker turn is running. A queued worker is not running.
 * 4. `waiting` — at least one unresolved blocker (a human-owed item or an
 *    agent-commander report), unless checks are pending on the current head and
 *    every blocker is owed to an agent (`agentCommanderReport`). A question,
 *    grant, connect step, human report, or merge hold stays waiting during CI.
 * 5. `review` — checks are pending on the current head: a pending rollup, or a
 *    push whose checks are not reported yet. There is no time cap. This lasts
 *    until a final check result or a new push.
 * 6. `working` — the last turn ended within 30 seconds and checks are not failing.
 * 7. `idle`.
 */
export function deriveCornerState(facts: CornerStateFacts): DerivedCornerState {
  const terminal = cornerRunFromLifecycle({ archived: facts.archived, lifecycle: facts.lifecycle });
  if (facts.archived || terminal.state === 'landed' || terminal.state === 'closed' ||
      facts.run?.state === 'landed' || facts.run?.state === 'closed')
    return { state: 'archived' };
  if (facts.reviewerActive) return { state: 'review' };
  const now = facts.now ?? Date.now() / 1000;
  if (facts.turnRunning) return { state: 'working' };
  const lifecycle = facts.lifecycle;
  const checks = lifecycle?.checksSummary?.status ?? lifecycle?.checks;
  const pendingCi = checks !== 'failing' && (checks === 'pending' || checksNotReported(lifecycle));
  if ((facts.blocker || facts.owed === true) && !(facts.agentCommanderReport && pendingCi))
    return { state: 'waiting', ...facts.blocker };
  if (pendingCi) return { state: 'review' };
  if (checks !== 'failing' && facts.lastTurnEndedAt !== undefined && now - facts.lastTurnEndedAt < 30)
    return { state: 'working' };
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
