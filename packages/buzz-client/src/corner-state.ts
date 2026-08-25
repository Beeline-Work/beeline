/**
 * The durable, daemon-owned corner lifecycle.
 *
 * Every current-state surface reads this one parameterized-replaceable record.
 * Transcript cards, ACP process state, drafts, and presence are evidence and
 * presentation only; none of them may promote a corner to an active state.
 */
import type { NostrEvent } from '@beeline/nostr';
import {
  KIND_CORNER_STATE,
  TAG_AGENT_DRAFT,
  TAG_AGENT_THOUGHT,
  TAG_CORNER_STATE,
} from './kinds.js';

export { KIND_CORNER_STATE };

export const CORNER_ACTIVITY_FRESHNESS_MS = 90_000;

export function cornerStateKey(cornerId: string): string {
  return `${TAG_CORNER_STATE}:${cornerId}`;
}

export function agentDraftKey(channelId: string): string {
  return `${TAG_AGENT_DRAFT}:${channelId}`;
}

/** One replaceable rolling-thought record per Room/corner. */
export function agentThoughtKey(channelId: string): string {
  return `${TAG_AGENT_THOUGHT}:${channelId}`;
}

export type CornerMachineState = 'open' | 'working' | 'waiting' | 'idle' | 'concluded' | 'closed';

export type CornerMachineReason = 'review' | 'question' | 'failure';

export type CornerStateRecord = {
  cornerId: string;
  parentRoomId?: string;
  state: CornerMachineState;
  reason?: CornerMachineReason;
  /** Unix seconds at which the daemon published this state. */
  at: number;
};

const TRANSITIONS: Readonly<Record<CornerMachineState, ReadonlySet<CornerMachineState>>> = {
  open: new Set(['open', 'working', 'waiting', 'idle', 'concluded', 'closed']),
  working: new Set(['working', 'waiting', 'idle', 'concluded', 'closed']),
  waiting: new Set(['waiting', 'working', 'idle', 'concluded', 'closed']),
  idle: new Set(['idle', 'working', 'waiting', 'concluded', 'closed']),
  concluded: new Set(['concluded', 'closed']),
  closed: new Set(['closed']),
};

/** Only a first `open` (or a cleanup-discovered `closed`) may start a record. */
export function canTransitionCornerState(
  from: CornerMachineState | undefined,
  to: CornerMachineState,
): boolean {
  if (from === undefined) return to === 'open' || to === 'closed';
  return TRANSITIONS[from].has(to);
}

export function assertCornerStateTransition(
  from: CornerMachineState | undefined,
  to: CornerMachineState,
): void {
  if (!canTransitionCornerState(from, to)) {
    throw new Error(`invalid corner lifecycle transition: ${from ?? 'none'} -> ${to}`);
  }
}

export function isCornerTerminalState(state: CornerMachineState): boolean {
  return state === 'concluded' || state === 'closed';
}

/**
 * `working` is a lease, not an immortal assertion. All other states remain
 * durable until the daemon publishes their next transition.
 */
export function isCornerStateRecordFresh(
  record: CornerStateRecord | undefined,
  now = Date.now(),
  freshnessMs = CORNER_ACTIVITY_FRESHNESS_MS,
): record is CornerStateRecord {
  if (!record || !Number.isFinite(record.at)) return false;
  if (record.state !== 'working') return true;
  const age = now - record.at * 1_000;
  // The daemon's replaceable publisher advances same-second transitions
  // monotonically, so a fresh record may be a few seconds ahead of wall time.
  // Bound that skew to the same horizon; an arbitrarily future timestamp can
  // never mint an immortal working lease.
  return age >= -freshnessMs && age <= freshnessMs;
}

/** Compatibility name retained for callers while the lifecycle migration lands. */
export const isCornerStateRecordCurrent = isCornerStateRecordFresh;

/** Parse one canonical record. Malformed data is absence, never an exception. */
export function parseCornerStateRecord(
  event: Pick<NostrEvent, 'tags'>,
): CornerStateRecord | undefined {
  const tag = (name: string): string | undefined =>
    event.tags.find((candidate) => candidate[0] === name)?.[1];
  const d = tag('d');
  if (!d?.startsWith(`${TAG_CORNER_STATE}:`)) return undefined;
  const rawState = tag('state');
  // Read the short-lived stage-2 word and normalize it immediately. No UI
  // surface ever receives the legacy vocabulary.
  const state = rawState === 'waiting-on-human' ? 'waiting' : rawState;
  if (
    state !== 'open' &&
    state !== 'working' &&
    state !== 'waiting' &&
    state !== 'idle' &&
    state !== 'concluded' &&
    state !== 'closed'
  ) {
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
  if (state !== 'waiting' && reasonRaw !== undefined) return undefined;
  const at = Number(tag('at'));
  const cornerId = d.slice(TAG_CORNER_STATE.length + 1);
  if (!cornerId || !Number.isSafeInteger(at) || at < 0) return undefined;
  const parentRoomId = tag('h');
  return {
    cornerId,
    ...(parentRoomId ? { parentRoomId } : {}),
    state,
    ...(reasonRaw ? { reason: reasonRaw } : {}),
    at,
  };
}
