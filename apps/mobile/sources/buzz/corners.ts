import type { CornerState, CornerStateReason } from '@beeline/api-contract/phone';

export type CornerSuperState = 'working' | 'needs-human' | 'finished';

const CORNER_STATE_PRECEDENCE: Readonly<Record<CornerState, number>> = {
  review: 0,
  working: 1,
  waiting: 2,
  archived: 3,
};

export type CornerSummary = {
  id: string;
  name: string;
  openerPubkey: string;
  /** Exact server-owned state. Clients never derive another status. */
  state: CornerState;
  reason?: CornerStateReason;
  stateAt?: number;
  /** Canonical WAITING/question projection used for its reply affordance. */
  awaitingReply?: boolean;
  /** Separate presence fact retained for compatibility. It cannot change the
   * canonical server state. */
  agentOffline?: boolean;
  createdAt?: number;
  /** Most recent activity timestamp seen for this corner (seconds); used to
   * pick the corner that's actually being worked on over a stale/empty one. */
  lastActivityAt?: number;
};

/** Resolve the indexed machine fact at paint time. Working is a lease whose
 * timestamp comes from the child turn receipt; durable lifecycle states do
 * not expire. */
/**
 * Compatibility super-state for presentation-only callers. Canonical record
 * selection happens before this helper receives a status.
 */
export function cornerSuperState(status: CornerState): Exclude<CornerSuperState, 'stalled'> {
  if (status === 'working') return 'working';
  if (status === 'archived') return 'finished';
  return 'needs-human';
}

/** Relative precedence that ranks canonical idle as least reportable. */
export function cornerStatusPrecedenceOrNull(status: CornerState): number {
  return CORNER_STATE_PRECEDENCE[status];
}

/** Corners still being actively worked on — the set that deserves a live
 * badge / sort-to-top treatment, as opposed to terminal or paused states.
 * Canonical idle is not active work. */
export function isCornerActive(status: CornerState): boolean {
  return status === 'working' || status === 'review';
}

export function isCornerNeedsYou(status: CornerState): boolean {
  return status === 'review' || status === 'waiting';
}

/**
 * A corner whose life is over: it landed or it was closed. Nothing
 * that reports *current* work may ever name one of these — the pinned corner
 * line above the composer least of all, since it is tappable and a terminal
 * corner is a read-only channel a tap strands the reader in. Written as the
 * complement of the three terminal words rather than as an allowlist of live
 * ones so a new non-terminal `CornerState` is reportable by default, and a
 * new terminal one has to be named here to become terminal.
 */
export function resolveCornerLifecycleStatus(
  known: CornerState,
  confirmedArchived: boolean,
): CornerState {
  return confirmedArchived ? 'archived' : known;
}

/**
 * A corner is titled by its NAME, which the agent supplies at open_corner and
 * which is at most three words (C89). Corners opened before the name existed
 * stored the whole objective in that slot, so the first three words stand in
 * — cut on a word boundary, never mid-word, and never with an ellipsis. Kept
 * local rather than imported from the SDK so no screen depends on a fresh
 * `dist/`; `packages/api-contract/src/corner-text.ts` holds the same rule for
 * the server and the daemon.
 */
export const CORNER_NAME_MAX_WORDS = 3;

export function cornerName(name: string | undefined, id: string): string {
  const candidate = name?.replace(/\s+/g, ' ').trim().replace(/^#+/, '').trim();
  if (!candidate || candidate.startsWith('sub-')) return `corner-${id.slice(0, 8)}`;
  const words = candidate.split(' ');
  return words.length <= CORNER_NAME_MAX_WORDS
    ? candidate
    : words.slice(0, CORNER_NAME_MAX_WORDS).join(' ');
}

/**
 * The ONE state-glyph family: circles, shared by Rooms and corners. Idle is a
 * hollow static circle, working is a spinning ring, and needs-you is filled.
 * The rendered component carries the exact state word only to accessibility.
 */
const CORNER_GLYPH_FILLED = '●';
const CORNER_GLYPH_HOLLOW = '○';

export type CornerVisualState = 'idle' | 'working' | 'needs-you';

const CORNER_VISUAL_STATE_RANK: Readonly<Record<CornerVisualState, number>> = {
  idle: 0,
  working: 1,
  'needs-you': 2,
};

/** The one presentation vocabulary rendered by both corners and Rooms. */
export function cornerVisualState(
  status: CornerState,
  opts?: { awaitingReply?: boolean; reason?: CornerStateReason; agentOffline?: boolean },
): CornerVisualState {
  // `agentOffline` remains in the compatibility shape, but presence is not a
  // lifecycle input. It may render beside this state, never rewrite it.
  if (status === 'working') return 'working';
  if (
    opts?.awaitingReply ||
    opts?.reason === 'question' ||
    opts?.reason === 'failed' ||
    status === 'review'
  ) {
    return 'needs-you';
  }
  return 'idle';
}

/** MAX-severity (join) of corner states. Commutative, associative, and
 * idempotent by construction; Room activity is intentionally not an input. */
export function roomState(
  corners: readonly Pick<
    CornerSummary,
    'state' | 'reason' | 'stateAt' | 'awaitingReply' | 'agentOffline'
  >[],
): CornerVisualState {
  return corners.reduce<CornerVisualState>((current, corner) => {
    const next = cornerVisualState(corner.state, {
      awaitingReply: corner.awaitingReply,
      reason: corner.reason,
    });
    return CORNER_VISUAL_STATE_RANK[next] > CORNER_VISUAL_STATE_RANK[current] ? next : current;
  }, 'idle');
}

export { CORNER_GLYPH_FILLED, CORNER_GLYPH_HOLLOW };

/**
 * Separate diagnostic for a canonically idle corner whose agent is provably
 * offline. It may explain the quiet state in a fact line; it never promotes or
 * demotes lifecycle.
 */
export function isCornerStalledOffline(
  corner: Pick<CornerSummary, 'state' | 'agentOffline'>,
): boolean {
  return corner.agentOffline === true && corner.state === 'waiting';
}

/**
 * The compatibility glyph/label source uses exactly the three visual words:
 * WORKING, NEEDS YOU, IDLE. Actual screens render `StateCircle` without a
 * visible label; this string is retained for nonvisual data and migration.
 *
 * Presence is deliberately ignored here; a separate fact line may explain
 * that the agent is offline without inventing another lifecycle status.
 */
export function cornerStatusPresentation(
  status: CornerState,
  opts?: { awaitingReply?: boolean; reason?: CornerStateReason; agentOffline?: boolean },
): {
  glyph: string;
  label: string;
} {
  switch (cornerVisualState(status, opts)) {
    case 'working':
      return { glyph: '◌', label: 'working' };
    case 'needs-you':
      return { glyph: CORNER_GLYPH_FILLED, label: 'review' };
    case 'idle':
      return { glyph: CORNER_GLYPH_HOLLOW, label: status };
  }
}

export function sortCorners(corners: CornerSummary[]): CornerSummary[] {
  return [...corners].sort((a, b) => {
    const statusDelta =
      cornerStatusPrecedenceOrNull(a.state) - cornerStatusPrecedenceOrNull(b.state);
    if (statusDelta !== 0) return statusDelta;
    return (
      (b.lastActivityAt ?? b.createdAt ?? 0) - (a.lastActivityAt ?? a.createdAt ?? 0) ||
      a.name.localeCompare(b.name)
    );
  });
}

/**
 * The Room-list dropdown is a live-work shortcut, so it lists every corner
 * still unfinished — working or needs-human, idle-without-finishing included
 * (its nudge/close affordance lives inside the corner). Archived corners are
 * excluded outright rather than shown dimmed: a
 * Room row's corner count must equal what the dropdown reveals, and a count
 * that includes rows a person cannot act on turns the index into a to-do
 * list of dead work.
 *
 * Excluded corners stay reachable through their durable cards in the parent
 * Room transcript and through the full `buzz/corners/[roomId]` list, which the
 * expanded dropdown links to. The allowlist is written out per status on
 * purpose: adding a new `CornerState` should force a decision here rather
 * than silently leaking into the index.
 */
export function roomListCorners(corners: readonly CornerSummary[]): CornerSummary[] {
  // The dropdown lists every UNFINISHED corner — working and needs-human
  // alike, idle-without-finishing included (its nudge/close affordance lives
  // inside). Only finished corners are excluded.
  return corners.filter((corner) => corner.state !== 'archived');
}

/**
 * The single status a Room row's leading glyph reports, or `null` when no
 * corner needs reporting. Derived from the same set the dropdown shows, so the
 * glyph can never advertise work the row's own count and dropdown hide.
 */
export function roomCornerSignal(corners: readonly CornerSummary[]): CornerState | null {
  switch (roomState(roomListCorners(corners))) {
    case 'needs-you':
      return 'review';
    case 'working':
      return 'working';
    case 'idle':
      return null;
  }
}
