/**
 * The four-terminal-states contract for an agent turn (owner directive
 * 2026-08-23: "it should never be idle").
 *
 * A corner turn may end in exactly four states:
 *   1. still working — another turn is running or queued;
 *   2. a fresh question to the human (an ask);
 *   3. a reviewable change presented (merge-ready);
 *   4. a declared failure.
 *
 * When a turn resolves with NONE of those holding — the agent produced only
 * narration and stopped — the daemon drives the corner to a terminal outcome
 * by steering the agent with one bounded "conclude" prompt through the same
 * path a human message takes. This module holds the pure half of that watch:
 * the episode bookkeeping shape, its bound and spacing rules, the conclude
 * prompt text, and ask detection. `Body` (apps/body/src/body.ts) owns the
 * wiring: turn-end marks, the maintenance-tick evaluation, and the nudge turn
 * itself.
 *
 * Everything here is deliberately free of I/O so the bound/spacing/ask rules
 * are unit-testable without a relay.
 */

/** Conclude nudges one quiet episode may spend before it is parked as stalled. */
export const MAX_CONCLUDE_NUDGES_PER_EPISODE = 2;

/**
 * Minimum spacing between two conclude nudges in one episode, so a slow model
 * is never double-prompted mid-thought. The running-turn guards make an
 * overlap impossible; this bounds the cadence when a turn resolves quickly
 * twice in a row without concluding.
 */
export const CONCLUDE_NUDGE_SPACING_MS = 90_000;

/** Per-corner quiet-episode state. Persisted in `DurableBodyState` keyed by
 *  corner id so a restart mid-episode neither resets the spent budget (nudge
 *  storms on resume) nor re-marks an already-resolved episode. */
export interface ConcludeEpisode {
  /** When the latest turn ended without any of the four terminal states (ms). */
  quietSince?: number;
  /** Conclude nudges already spent in this episode. */
  nudges: number;
  /** When the most recent conclude nudge was issued (ms). */
  lastNudgeAt?: number;
  /**
   * The single honest needs-attention card ("agent stalled without
   * concluding") went out for this episode. The episode stays parked — no
   * further nudges — until something real resets it (a review, an ask, or a
   * human message starting a fresh episode).
   */
  stalledNotified?: boolean;
}

export function freshConcludeEpisode(): ConcludeEpisode {
  return { nudges: 0 };
}

/** A quiet episode is due for evaluation once its spacing window has passed. */
export function concludeNudgeDue(
  episode: ConcludeEpisode,
  nowMs: number,
  spacingMs: number = CONCLUDE_NUDGE_SPACING_MS,
): boolean {
  if (episode.quietSince === undefined) return false;
  if (episode.lastNudgeAt !== undefined && nowMs - episode.lastNudgeAt < spacingMs) return false;
  return true;
}

/** The episode has spent every conclude nudge it had. */
export function concludeEpisodeExhausted(episode: ConcludeEpisode): boolean {
  return episode.nudges >= MAX_CONCLUDE_NUDGES_PER_EPISODE;
}

/**
 * The conclude prompt itself. One bounded ask: present committed work for
 * review, ask what you need, or state plainly what is done/failed and why.
 * The per-turn instruction suffixes (`CORNER_TARGET_SYNC_INSTRUCTION` etc.)
 * are appended by the caller, mirroring every other corner turn shape.
 */
export const CONCLUDE_PROMPT = [
  'Your last reply ended without concluding this corner. Do not start new work.',
  'Do exactly one of the following, then stop:',
  '1. If completed work exists, commit it to your feature branch so Beeline can present it for review.',
  '2. If you need something from the human, ask one clear question.',
  '3. Otherwise, state plainly what is done, what failed, and why.',
].join('\n');

/** Deterministic fallback if the conclude turn itself dies before replying. */
export const CONCLUDE_TURN_FALLBACK =
  'I could not complete my previous reply. I have no new work to present and no open question; this corner is waiting on direction.';

/**
 * An agent-authored question awaiting a person. Mirrors buzz-client's
 * `isAgentAsk`: narration (`agent-message`) whose text bears a question mark.
 * Progress/retry noise never asks anything, so the bare test suffices.
 */
export function textIsAsk(text: string): boolean {
  return /\?/.test(text);
}

/**
 * Whether the corner channel's newest decisive event is an unanswered agent
 * ask. Walking newest-first, the first event that decides wins: a human
 * message answers any earlier ask; an agent narration bearing '?' IS the
 * standing ask. Daemon-authored control/activity traffic is skipped — it
 * asks nothing and must not mask a real question underneath it.
 */
export function standingAskFromEvents(
  events: readonly NostrEventLike[],
  agentPubkey: string,
): boolean {
  const sorted = [...events].sort(
    (a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id),
  );
  for (const evt of sorted) {
    if (evt.pubkey !== agentPubkey) return false;
    const t = evt.tags?.find((tag) => tag[0] === 't')?.[1];
    if (t === 'agent-message' && textIsAsk(evt.content)) return true;
  }
  return false;
}

interface NostrEventLike {
  id: string;
  pubkey: string;
  created_at: number;
  content: string;
  tags?: string[][];
}
