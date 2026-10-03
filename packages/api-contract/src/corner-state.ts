import type { CornerLifecycleView, CornerState, CornerStateReason } from './phone-types.js';

/**
 * Where a corner's workflow run currently sits: the `toState` of its newest
 * handoff card, and the outcome of the edge that brought it there. State names
 * are the server's corner workflow contract (`apps/server/src/corner-lifecycle.ts`).
 */
export type CornerRunFacts = {
  readonly state: string;
  readonly outcome?: string;
};

export type CornerStateFacts = {
  readonly archived: boolean;
  readonly turnRunning: boolean;
  /** The corner's workflow run. Absent only where no run is known; see `cornerRunFromLifecycle`. */
  readonly run?: CornerRunFacts;
  readonly lifecycle?: CornerLifecycleView;
  /**
   * Whether something in the corner is still owed to a person: a message the
   * push rule addresses to someone that they have not answered, an open
   * question card, or a pending grant. Absent where a projection cannot tell;
   * the corner then stays `waiting` so nothing owed is hidden.
   */
  readonly owed?: boolean;
};

export type DerivedCornerState = {
  readonly state: CornerState;
  readonly reason?: CornerStateReason;
};

/**
 * The run a corner is in when no handoff card records one: a corner opened
 * before the workflow run existed, or a projection (the relay indexer, an older
 * server's Room view) that only carries the lifecycle. The server writes this
 * once as the run of such a corner, so the badge and the server agree.
 *
 * - ended (archived, merged, done, abandoned) -> `landed` or `closed`
 * - a PR with failing checks -> `implement`, reached by `failing`
 * - a PR with passing checks -> `review`
 * - a PR with pending or unknown checks -> `checks`
 * - a question waiting on a person -> `ask_human`
 * - a failed turn -> `implement`, reached by `failed` (no contract edge; only
 *   this mapping produces it, so the badge can still say "failed")
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
 * The phone badge, from the workflow run plus whether a turn is running:
 *
 * | run state                                   | badge                      |
 * | ------------------------------------------- | -------------------------- |
 * | `landed`, `closed`, or an archived Room     | archived                   |
 * | any other, while a turn runs                | working                    |
 * | `checks`, `review`, `land`                  | review                     |
 * | `implement` reached by `failing`            | review, checks-failed      |
 * | `ask_human`                                 | waiting, question          |
 * | `implement` reached by `failed`             | waiting, failed            |
 * | `opened`, `no_code_work`, `upgrade_to_code`, `implement`, owed | waiting |
 * | the same, nothing owed to anyone            | idle                       |
 */
export function deriveCornerState(facts: CornerStateFacts): DerivedCornerState {
  const run =
    facts.run ?? cornerRunFromLifecycle({ archived: facts.archived, lifecycle: facts.lifecycle });
  if (facts.archived || run.state === 'landed' || run.state === 'closed')
    return { state: 'archived' };
  if (facts.turnRunning) return { state: 'working' };
  if (run.state === 'checks' || run.state === 'review' || run.state === 'land')
    return { state: 'review' };
  if (run.state === 'implement' && run.outcome === 'failing')
    return { state: 'review', reason: 'checks-failed' };
  if (run.state === 'ask_human') return { state: 'waiting', reason: 'question' };
  if (run.state === 'implement' && run.outcome === 'failed')
    return { state: 'waiting', reason: 'failed' };
  return { state: facts.owed === false ? 'idle' : 'waiting' };
}
