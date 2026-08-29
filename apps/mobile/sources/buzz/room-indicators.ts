import {
  isCornerTerminal,
  currentCornerStatus,
  type CornerStatus,
  type CornerSummary,
} from './corners';

/**
 * The two things a Room reports above its composer are *different facts about
 * different objects*, and this module exists to keep them from ever being
 * derived from one another again.
 *
 *   **A turn is in progress.** The agent is composing a reply in this Room.
 *   Wire signal: a `#t=agent-turn` `working` event published on the Room's own
 *   channel (`postAgentTurnStatus`, `apps/body/src/body.ts`). It is transient,
 *   it names no corner, and it is nothing to tap.
 *
 *   **A corner is active.** A child edit channel exists and its canonical
 *   parameterized-replaceable state record says `working` within the freshness
 *   horizon. Parent-Room kind:9 body-control `corner-open` / `corner-close`
 *   messages are transcript history only and are never lifecycle authority.
 *
 * `selectPinnedCorner` takes canonical corner state and nothing else; the turn
 * indicator and transcript control messages cannot promote a corner into it.
 */
export type PinnedCorner = {
  cornerId: string;
  status: CornerStatus;
};

export type PinnedCornerInput = {
  /** Canonical daemon lifecycle snapshots for relay-existing corners. */
  lifecycle: readonly CornerSummary[];
  now?: number;
};

export type TurnProgressInput = {
  /** Corners trust their own channel-local turn proof even if Room presence is stale. */
  isCorner: boolean;
  agentsOffline: boolean;
  activeTurnPubkey?: string;
};

/**
 * The channel-local agent whose active turn should light the thinking line.
 *
 * The server-indexed latest WORKING receipt is the only proof. Draft streams
 * are content overlays, not lifecycle: they can start late and a lost retract
 * can leave one open forever. Room-wide offline state may hide a Room
 * indicator, but it cannot veto channel-local proof inside a Corner.
 */
export function selectTurnProgressAgentPubkey(input: TurnProgressInput): string | null {
  if (!input.isCorner && input.agentsOffline) return null;
  return input.activeTurnPubkey ?? null;
}

/** How long a locally-armed "buzzing" ack waits for the real WORKING receipt
 * before it must stop implying the daemon is still on its way. */
export const COMPOSER_ACK_BOUND_MS = 15_000;

export type ComposerAckState =
  | { kind: 'thinking'; agentPubkey: string }
  | { kind: 'buzzing' }
  | { kind: 'delivery-unclear' };

export type ComposerAckInput = TurnProgressInput & {
  /** Set the instant a message addressed to an agent is sent; cleared once
   * the real receipt lands, a fresher send re-arms it, or nothing addressed
   * an agent this turn. */
  pendingAckSentAt?: number;
  now: number;
};

/**
 * The composer's immediate answer to "did anything happen yet". A real
 * `#t=agent-turn` WORKING receipt is a relay round trip away — pickup,
 * publish, refetch — which reads as dead air for however long that takes.
 * `pendingAckSentAt` is a purely local fact (armed the instant the user sends
 * a message this client believes addresses an agent) and is *replaced* by the
 * real receipt the moment one exists, never raced against it: `thinking`
 * always wins once `selectTurnProgressAgentPubkey` has an answer. Past
 * `COMPOSER_ACK_BOUND_MS` with still no receipt, the honest answer is that
 * delivery cannot be confirmed yet — never silently keep claiming "buzzing"
 * forever, and never fall back to dead air either.
 */
export function selectComposerAckState(input: ComposerAckInput): ComposerAckState | null {
  const activePubkey = selectTurnProgressAgentPubkey(input);
  if (activePubkey) return { kind: 'thinking', agentPubkey: activePubkey };
  if (input.pendingAckSentAt == null) return null;
  const elapsed = input.now - input.pendingAckSentAt;
  if (elapsed < 0) return null;
  return elapsed < COMPOSER_ACK_BOUND_MS ? { kind: 'buzzing' } : { kind: 'delivery-unclear' };
}

/**
 * Which qualifying corner to pin when more than one is open at once. This is
 * a *selection* priority, deliberately not `cornerStatusPrecedence` (which
 * resolves conflicting reports of one corner's status and must stay
 * terminal-highest for that job): a corner ready for review is the most
 * actionable thing a captain can do about it, so it wins the single pin even
 * over one still being actively worked.
 */
const PIN_RELEVANCE: Record<string, number> = {
  open: 0,
  live: 1,
  'needs-attention': 2,
  stalled: 2,
  failed: 3,
  merged: 3,
  archived: 3,
};

/**
 * The one corner the pinned line may name, or `null` for none.
 *
 * The line's presence means "this corner is open and worth returning to" —
 * `live` (working), `needs-attention` (waiting on a human), and `open`
 * (review-ready) all qualify. Only a terminal status (`merged`/`failed`/
 * `archived`) is "no line". When several corners qualify at once, a
 * review-ready one wins, then a working one, then the most recently active.
 */
export function selectPinnedCorner(input: PinnedCornerInput): PinnedCorner | null {
  const status = new Map<string, CornerStatus>();
  const seenAt = new Map<string, number>();

  for (const corner of input.lifecycle) {
    // A transcript-derived `status` without the canonical machine record is
    // not lifecycle authority. In particular, a parent kind:9 corner-open
    // control message can remain in history forever and must never pin itself.
    if (!corner.machineState) continue;
    const canonical = currentCornerStatus(corner, input.now);
    if (canonical !== null) status.set(corner.id, canonical);
    seenAt.set(
      corner.id,
      Math.max(seenAt.get(corner.id) ?? 0, corner.lastActivityAt ?? corner.createdAt ?? 0),
    );
  }

  const candidates = [...status.entries()]
    .filter(([, value]) => !isCornerTerminal(value))
    .sort(
      ([leftId, left], [rightId, right]) =>
        PIN_RELEVANCE[left] - PIN_RELEVANCE[right] ||
        (seenAt.get(rightId) ?? 0) - (seenAt.get(leftId) ?? 0) ||
        leftId.localeCompare(rightId),
    );
  const best = candidates[0];
  return best ? { cornerId: best[0], status: best[1] } : null;
}

/**
 * Gold, and the breath that goes with it, mean one thing product-wide: an
 * agent is alive and working *in that corner*. `needs-attention` and `open`
 * are pinned too (see `selectPinnedCorner`) but are not running work, so they
 * render on the quiet tier with no pulse — this is the one test that decides
 * which of a pinned corner's non-terminal statuses earns the gold treatment.
 */
export function isPinnedCornerLive(status: CornerStatus): boolean {
  return status === 'live';
}

/** A pinned corner has an approvable change waiting — the pinned line should
 * say so rather than a generic "active"/"idle". */
export function isPinnedCornerReadyForReview(status: CornerStatus): boolean {
  return status === 'open';
}
