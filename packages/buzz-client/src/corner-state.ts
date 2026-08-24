/**
 * THE daemon-authoritative corner state record.
 *
 * A corner's lifecycle is exactly one of three states — working |
 * waiting-on-human | idle. The DAEMON decides which one holds and publishes it as a
 * parameterized-replaceable kind:30078 record (one per corner, `d` keyed),
 * following the proven agent-presence pattern: strictly monotonic
 * `created_at`, coalesced retries, no publish on planned shutdown.
 *
 * This record is additive: readers prefer it when fresh and fall back to the
 * history-solving oracle (`corner-lifecycle.ts`) when absent or stale. The
 * fallback path is what stage 3 of the migration deletes, so readers must
 * keep it isolated in ONE module (mobile's `corner-state-verdict.ts`).
 */
import type { NostrEvent } from '@beeline/nostr';
import { KIND_CORNER_STATE, TAG_CORNER_STATE } from './kinds.js';

export { KIND_CORNER_STATE };

/** The `d` of a corner's state record. Kind:30078 replaceable records are
 * relay-indexed by `d` — a `#h` filter matches nothing. One builder so the
 * publisher and every reader cannot drift (the presence lesson). */
export function cornerStateKey(cornerId: string): string {
  return `${TAG_CORNER_STATE}:${cornerId}`;
}

/** The three daemon-authoritative states, nothing more. Existing immutable
 * merge/archive facts remain the terminal authority and fold out of the deck. */
export type CornerMachineState = 'working' | 'waiting-on-human' | 'idle';

/** Why a corner waits on a person (`review`: an approvable change exists;
 * `question`: the agent asked something; `failure`: delivery/work stopped). */
export type CornerMachineReason = 'review' | 'question' | 'failure';

export type CornerStateRecord = {
  cornerId: string;
  state: CornerMachineState;
  reason?: CornerMachineReason;
  /** The record's `at` tag (unix seconds) — the moment the daemon last spoke.
   * Readers compare this against the newest known corner transcript event to
   * decide whether the record still describes the present. */
  at: number;
};

/** Parse one state record off the wire. Returns undefined for anything that
 * is not a well-formed corner-state record — absence is how readers decide
 * to fall back, so malformed shapes must degrade, never throw. */
export function parseCornerStateRecord(
  event: Pick<NostrEvent, 'tags'>,
): CornerStateRecord | undefined {
  const tag = (name: string): string | undefined =>
    event.tags.find((candidate) => candidate[0] === name)?.[1];
  const d = tag('d');
  if (!d?.startsWith(`${TAG_CORNER_STATE}:`)) return undefined;
  const state = tag('state');
  if (state !== 'working' && state !== 'waiting-on-human' && state !== 'idle') {
    return undefined;
  }
  const reasonRaw = tag('reason');
  if (
    reasonRaw !== undefined &&
    reasonRaw !== 'review' &&
    reasonRaw !== 'question' &&
    reasonRaw !== 'failure'
  ) {
    return undefined;
  }
  const reason =
    reasonRaw === 'review' || reasonRaw === 'question' || reasonRaw === 'failure'
      ? reasonRaw
      : undefined;
  const at = Number(tag('at'));
  const cornerId = d.slice(TAG_CORNER_STATE.length + 1);
  if (!cornerId || !Number.isSafeInteger(at) || at < 0) return undefined;
  return {
    cornerId,
    state,
    ...(reason !== undefined ? { reason } : {}),
    at,
  };
}

/**
 * Whether a state record still describes the corner's present: its `at` must
 * be at least as new as the newest known corner transcript event. An older
 * record means something has happened the daemon has not yet re-stated (or
 * the reader's transcript window is ahead of it) — fall back to history.
 */
export function isCornerStateRecordCurrent(
  record: CornerStateRecord | undefined,
  newestTranscriptAt: number,
): record is CornerStateRecord {
  if (!record || !Number.isFinite(record.at)) return false;
  // Equal timestamps count as current: the daemon often speaks in the same
  // second as the turn event that ended its turn.
  return record.at >= newestTranscriptAt;
}
