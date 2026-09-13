import type { CornerLifecycleView, CornerState, CornerStateReason } from './phone-types.js';

export type CornerStateFacts = {
  readonly archived: boolean;
  readonly turnRunning: boolean;
  readonly lifecycle?: CornerLifecycleView;
};

export type DerivedCornerState = {
  readonly state: CornerState;
  readonly reason?: CornerStateReason;
};

/** Pure state transition shared by every server-side corner projection. */
export function deriveCornerState(facts: CornerStateFacts): DerivedCornerState {
  const lifecycle = facts.lifecycle;
  const rawState = String(lifecycle?.lifecycle ?? '').trim().toLowerCase();
  const merged = Boolean(lifecycle?.pr?.mergedAt) || lifecycle?.outcome === 'landed';
  const ended =
    facts.archived ||
    merged ||
    lifecycle?.outcome === 'abandoned' ||
    ['done', 'concluded', 'closed', 'merged', 'abandoned', 'cleaned'].includes(rawState);
  if (ended) return { state: 'archived' };

  if (facts.turnRunning) return { state: 'working' };

  if (lifecycle?.pr) {
    const checks = lifecycle.checksSummary?.status ?? lifecycle.checks;
    return checks === 'failing'
      ? { state: 'review', reason: 'checks-failed' }
      : { state: 'review' };
  }

  const rawReason = lifecycle?.reason?.trim().toLowerCase();
  if (rawReason === 'question' || rawState === 'question') {
    return { state: 'waiting', reason: 'question' };
  }
  if (
    rawReason === 'failure' ||
    rawReason === 'failed' ||
    rawState === 'failure' ||
    rawState === 'failed'
  ) {
    return { state: 'waiting', reason: 'failed' };
  }
  return { state: 'waiting' };
}
