/**
 * THE corner state reader: prefer the daemon-authoritative record, fall back
 * to the history-solving oracle.
 *
 * Stage 2 of the three-state migration (captain approved 2026-08-23). When a
 * fresh `buzz-corner-state` record exists (its `at` is at least the newest
 * known corner transcript event), the verdict is a DUMB LOOKUP — no history
 * re-derivation at all:
 *
 * - `working`          → live (spinner; DOESN'T NEED YOU)
 * - `waiting-on-human` → needs-you gold, EXCEPT when the agent is provably
 *                        offline and the reason is a question/unknown wait
 *                        (nothing to act on with nobody home) — demoted to the
 *                        honest "Agent offline" line, never gold;
 *   - `review`         → an approvable artifact stands; golds EVEN offline;
 *   - `question`       → a fresh unanswered ask; golds with REPLY affordance;
 *   - `failure`        → the daemon only emits this over an actionable
 *                        artifact, so it golds too.
 * - `idle`             → grey DOESN'T NEED YOU (`null`, quiet).
 * When the record is absent or stale, THIS module is the one place the old
 * history solver still runs (stage 3 deletes it here and only here). A
 * console counter fires on every fallback so stage-3 readiness is measurable.
 */
import { isCornerStateRecordCurrent, type CornerStateRecord } from '@beeline/buzz-client';
import {
  resolveCornerLifecycle,
  resolveCornerState,
  type CornerLifecycleFact,
  type CornerStatus,
} from '@/buzz/corners';

export type CornerVerdictSource = 'record' | 'fallback';

export type CornerVerdict = {
  status: CornerStatus | null;
  awaitingReply?: boolean;
  agentOffline?: boolean;
  source: CornerVerdictSource;
};

/** Telemetry: how many verdicts fell back to the history solver in this
 * session. When this stops climbing for every real corner, stage 3 can
 * delete the solver. Readable from tests via {@link cornerStateFallbackCount}. */
let fallbackCount = 0;

/** Last time we logged a fallback for a given corner, so a deck refresh loop
 * cannot spam the console: count always increments, log at most once per
 * corner per minute. */
const fallbackLoggedAt = new Map<string, number>();

export function cornerStateFallbackCount(): number {
  return fallbackCount;
}

/** Test seam: reset telemetry between cases. */
export function resetCornerStateFallbackTelemetry(): void {
  fallbackCount = 0;
  fallbackLoggedAt.clear();
}

/**
 * The dumb lookup off a fresh state record. Pure; exported for tests.
 * `agentOffline` follows the same tri-state discipline as the oracle's soft
 * presence input: `true` only when EVERY presence record for the Room is
 * provably past its lease; `undefined` = unknown = behave as online.
 */
export function cornerVerdictFromRecord(
  record: CornerStateRecord,
  agentOffline?: boolean,
): CornerVerdict {
  switch (record.state) {
    case 'working':
      return { status: 'live', source: 'record' };
    case 'idle':
      return { status: null, source: 'record' };
    case 'waiting-on-human': {
      // Offline demotion: a question/unknown wait with nobody home is not
      // waiting on YOU. The stalled shape (status null + agentOffline flag)
      // renders "Agent offline · <name>" and never golds. Review and failure
      // records are artifact-backed by the daemon, so a person can still act
      // on them while the agent is offline.
      if (agentOffline === true && record.reason !== 'review' && record.reason !== 'failure') {
        return { status: null, agentOffline: true, source: 'record' };
      }
      if (record.reason === 'review') return { status: 'open', source: 'record' };
      if (record.reason === 'question') {
        return { status: 'needs-attention', awaitingReply: true, source: 'record' };
      }
      if (record.reason === 'failure') return { status: 'failed', source: 'record' };
      return { status: 'needs-attention', source: 'record' };
    }
    default:
      // Runtime parsing rejects every non-three-state word. This defensive
      // branch only protects a caller holding an older compiled client type.
      return { status: null, source: 'record' };
  }
}

/**
 * The legacy path, isolated verbatim so stage 3 deletes it cleanly: THE one
 * oracle over corner-channel history plus the ask/offline refinements the
 * transport used to inline. Do not add new logic here — new behavior belongs
 * to the record path above or to the oracle module itself.
 */
function legacyVerdictFromHistory(
  facts: ReadonlyArray<CornerLifecycleFact>,
  merged: boolean,
  archived: boolean,
  agentOffline?: boolean,
): CornerVerdict {
  const oracleOptions = {
    merged,
    archived,
    ...(agentOffline ? { agentOffline: true } : {}),
  };
  const status = resolveCornerLifecycle(facts, oracleOptions);
  // A `null` word hides WHICH needs-human case holds: a fresh unanswered agent
  // ask (a person must reply) or a merely idle stalled corner (nobody must).
  // Re-run the oracle with the ask window closed: only a corner the ask
  // itself holds in needs-human flips without it. Same oracle, twice.
  const awaitingReply =
    status === null &&
    resolveCornerState(facts, oracleOptions) === 'needs-human' &&
    resolveCornerState(facts, { ...oracleOptions, askFreshWindowMs: 0 }) === 'working';
  // The soft presence input only surfaces when it actually changed the
  // verdict to STALLED — an offline agent holding a reviewable change stays
  // needs-you and carries no offline flag.
  const stalledOffline =
    agentOffline === true && resolveCornerState(facts, oracleOptions) === 'stalled';
  return {
    status,
    ...(awaitingReply ? { awaitingReply: true } : {}),
    ...(stalledOffline ? { agentOffline: true } : {}),
    source: 'fallback',
  };
}

/**
 * One corner verdict. Terminal relay truth (`merged` from a parent merge
 * summary, `archived` from channel metadata) wins outright regardless of any
 * record — a closed corner must never be resurrected by a stale record.
 */
export function resolveCornerVerdict(input: {
  cornerId: string;
  stateRecord?: CornerStateRecord | undefined;
  /** Newest known corner transcript event, unix seconds. */
  newestTranscriptAt: number;
  facts: ReadonlyArray<CornerLifecycleFact>;
  merged: boolean;
  archived: boolean;
  agentOffline?: boolean;
  now?: number;
}): CornerVerdict {
  if (!input.merged && !input.archived) {
    if (isCornerStateRecordCurrent(input.stateRecord, input.newestTranscriptAt)) {
      return cornerVerdictFromRecord(input.stateRecord, input.agentOffline);
    }
    // Fallback telemetry: counted every time, logged at most once per corner
    // per minute so deck refreshes stay readable while stage-3 readiness
    // stays measurable.
    fallbackCount += 1;
    const last = fallbackLoggedAt.get(input.cornerId);
    const nowMs = input.now ?? Date.now();
    if (last === undefined || nowMs - last >= 60_000) {
      fallbackLoggedAt.set(input.cornerId, nowMs);
      console.log(
        `[corner-state] no fresh state record for ${input.cornerId}; falling back to history solver (total ${fallbackCount})`,
      );
    }
  }
  return legacyVerdictFromHistory(input.facts, input.merged, input.archived, input.agentOffline);
}
