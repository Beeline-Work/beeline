/**
 * Corner lifecycle + presentation for every Buzz surface.
 *
 * Product lifecycle comes only from the server-indexed five-state DTO. Turn
 * receipts and presence may light transient UI, but never solve lifecycle.
 *
 * Canonical states: `live` (working), `open` (ready-for-review),
 * `needs-attention` (needs-decision), `failed`, `merged`, `archived`; `null`
 * or absence means idle / nothing reportable.
 */
export type CornerStatus =
  | 'live'
  | 'open'
  | 'needs-attention'
  | 'failed'
  | 'merged'
  | 'archived';
export type CornerMachineState = 'open' | 'working' | 'waiting' | 'idle' | 'concluded' | 'closed';
export type CornerSuperState = 'working' | 'needs-human' | 'finished';

const CORNER_STATUS_PRECEDENCE: Readonly<Record<CornerStatus, number>> = {
  archived: 0,
  merged: 1,
  failed: 2,
  'needs-attention': 3,
  open: 4,
  live: 5,
};

export type CornerSummary = {
  id: string;
  name: string;
  openerPubkey: string;
  /** Compatibility projection of the canonical record. Surfaces must call
   * `currentCornerStatus`, which refuses this word without machineState. */
  status: CornerStatus | null;
  /** Exact canonical daemon state and its lease timestamp. */
  machineState?: CornerMachineState;
  machineReason?: 'review' | 'question' | 'failure';
  stateAt?: number;
  /** Canonical WAITING/question projection used for its reply affordance. */
  awaitingReply?: boolean;
  /** Separate presence fact retained for compatibility. It cannot change the
   * canonical lifecycle returned by `currentCornerStatus`. */
  agentOffline?: boolean;
  createdAt?: number;
  /** Most recent activity timestamp seen for this corner (seconds); used to
   * pick the corner that's actually being worked on over a stale/empty one. */
  lastActivityAt?: number;
};

/** Compatibility presentation of the already-derived server lifecycle. */
export function currentCornerStatus(
  corner: Pick<CornerSummary, 'status' | 'machineState' | 'machineReason' | 'stateAt'>,
  _now = Date.now(),
): CornerStatus | null {
  return corner.status;
}

/**
 * Compatibility super-state for presentation-only callers. Canonical record
 * selection happens before this helper receives a status.
 */
export function cornerSuperState(
  status: CornerStatus | null,
): Exclude<CornerSuperState, 'stalled'> {
  if (status === null) return 'needs-human';
  if (status === 'live') return 'working';
  if (status === 'merged' || status === 'archived') return 'finished';
  return 'needs-human';
}

/** Relative precedence that ranks canonical idle as least reportable. */
export function cornerStatusPrecedenceOrNull(status: CornerStatus | null): number {
  return status === null ? Number.MAX_SAFE_INTEGER : CORNER_STATUS_PRECEDENCE[status];
}

/** Corners still being actively worked on — the set that deserves a live
 * badge / sort-to-top treatment, as opposed to terminal or paused states.
 * Canonical idle is not active work. */
export function isCornerActive(status: CornerStatus | null): boolean {
  return status === 'live' || status === 'needs-attention';
}

export function isCornerNeedsYou(status: CornerStatus | null): boolean {
  return status === 'open' || status === 'needs-attention' || status === 'failed';
}

/**
 * A corner whose life is over: it landed or it was closed. Nothing
 * that reports *current* work may ever name one of these — the pinned corner
 * line above the composer least of all, since it is tappable and a terminal
 * corner is a read-only channel a tap strands the reader in. Written as the
 * complement of the three terminal words rather than as an allowlist of live
 * ones so a new non-terminal `CornerStatus` is reportable by default, and a
 * new terminal one has to be named here to become terminal.
 */
export function isCornerTerminal(status: CornerStatus | null): boolean {
  return status === 'merged' || status === 'archived';
}

export function resolveCornerLifecycleStatus(
  known: CornerStatus | null,
  confirmedArchived: boolean,
): CornerStatus | null {
  return confirmedArchived ? 'archived' : known;
}

export function cornerName(name: string | undefined, id: string): string {
  const candidate = name?.trim().replace(/^#+/, '').replace(/\s+/g, '-');
  if (!candidate || candidate.startsWith('sub-')) return `corner-${id.slice(0, 8)}`;
  return candidate;
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
  status: CornerStatus | null,
  opts?: { awaitingReply?: boolean; agentOffline?: boolean },
): CornerVisualState {
  // `agentOffline` remains in the compatibility shape, but presence is not a
  // lifecycle input. It may render beside this state, never rewrite it.
  if (status === 'live') return 'working';
  if (
    opts?.awaitingReply ||
    status === 'open' ||
    status === 'needs-attention' ||
    status === 'failed'
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
    'status' | 'machineState' | 'machineReason' | 'stateAt' | 'awaitingReply' | 'agentOffline'
  >[],
): CornerVisualState {
  return corners.reduce<CornerVisualState>((current, corner) => {
    const next = cornerVisualState(currentCornerStatus(corner), {
      awaitingReply: corner.awaitingReply,
    });
    return CORNER_VISUAL_STATE_RANK[next] > CORNER_VISUAL_STATE_RANK[current] ? next : current;
  }, 'idle');
}

export function cornerGlyphForStatus(
  status: CornerStatus | null,
  opts?: { awaitingReply?: boolean; agentOffline?: boolean },
): string {
  switch (cornerVisualState(status, opts)) {
    case 'working':
      return '◌';
    case 'needs-you':
      return CORNER_GLYPH_FILLED;
    case 'idle':
      return CORNER_GLYPH_HOLLOW;
  }
}

export { CORNER_GLYPH_FILLED, CORNER_GLYPH_HOLLOW };

/**
 * Separate diagnostic for a canonically idle corner whose agent is provably
 * offline. It may explain the quiet state in a fact line; it never promotes or
 * demotes lifecycle.
 */
export function isCornerStalledOffline(
  corner: Pick<CornerSummary, 'status' | 'agentOffline'>,
): boolean {
  return (
    corner.agentOffline === true &&
    corner.status !== 'open' &&
    corner.status !== 'failed' &&
    corner.status !== 'merged' &&
    corner.status !== 'archived'
  );
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
  status: CornerStatus | null,
  opts?: { awaitingReply?: boolean; agentOffline?: boolean },
): {
  glyph: string;
  label: string;
} {
  switch (cornerVisualState(status, opts)) {
    case 'working':
      return { glyph: '◌', label: 'WORKING' };
    case 'needs-you':
      return { glyph: CORNER_GLYPH_FILLED, label: 'NEEDS YOU' };
    case 'idle':
      return { glyph: CORNER_GLYPH_HOLLOW, label: 'IDLE' };
  }
}

export function sortCorners(corners: CornerSummary[]): CornerSummary[] {
  return [...corners].sort((a, b) => {
    const statusDelta =
      cornerStatusPrecedenceOrNull(currentCornerStatus(a)) -
      cornerStatusPrecedenceOrNull(currentCornerStatus(b));
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
 * (its nudge/close affordance lives inside the corner). Terminal corners —
 * `merged`, `archived` — are excluded outright rather than shown dimmed: a
 * Room row's corner count must equal what the dropdown reveals, and a count
 * that includes rows a person cannot act on turns the index into a to-do
 * list of dead work.
 *
 * Excluded corners stay reachable through their durable cards in the parent
 * Room transcript and through the full `buzz/corners/[roomId]` list, which the
 * expanded dropdown links to. The allowlist is written out per status on
 * purpose: adding a new `CornerStatus` should force a decision here rather
 * than silently leaking into the index.
 */
const ROOM_LIST_WORDED_STATUSES: ReadonlySet<CornerStatus> = new Set<CornerStatus>([
  'live',
  'needs-attention',
  'open',
  'failed',
]);

export function roomListCorners(corners: readonly CornerSummary[]): CornerSummary[] {
  // The dropdown lists every UNFINISHED corner — working and needs-human
  // alike, idle-without-finishing included (its nudge/close affordance lives
  // inside). Only finished corners are excluded.
  return corners.filter((corner) => {
    if (
      !corner.machineState ||
      corner.machineState === 'concluded' ||
      corner.machineState === 'closed'
    )
      return false;
    const status = currentCornerStatus(corner);
    return status === null || ROOM_LIST_WORDED_STATUSES.has(status);
  });
}

/**
 * The single status a Room row's leading glyph reports, or `null` when no
 * corner needs reporting. Derived from the same set the dropdown shows, so the
 * glyph can never advertise work the row's own count and dropdown hide.
 */
export function roomCornerSignal(corners: readonly CornerSummary[]): CornerStatus | null {
  switch (roomState(roomListCorners(corners))) {
    case 'needs-you':
      return 'needs-attention';
    case 'working':
      return 'live';
    case 'idle':
      return null;
  }
}

export type CornerActivitySignal = {
  subchannelId: string;
  status: CornerStatus;
  timestamp: number;
};
