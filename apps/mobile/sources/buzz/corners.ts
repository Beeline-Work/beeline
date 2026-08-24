/**
 * Corner lifecycle + presentation for every Buzz surface.
 *
 * The DERIVATION lives in exactly one place: `resolveCornerLifecycle` and its
 * supporting vocabulary in `@beeline/buzz-client` (`corner-lifecycle.ts`) —
 * the #360 resolver grown into the canonical oracle. The Room deck row, the
 * deck's expanded corner rows, the pinned room bar, the corner screen's badge
 * and action card, and the daemon itself all consume that one verdict; this
 * module is mobile's single import surface for it plus the presentation
 * helpers (glyphs, labels, ordering) that are view concerns.
 *
 * Canonical states: `live` (working), `open` (ready-for-review),
 * `needs-attention` (needs-decision), `failed`, `merged`, `archived`; `null`
 * or absence means idle / nothing reportable.
 */
export {
  CORNER_ASK_FRESH_WINDOW_MS,
  CORNER_NEEDS_YOU_STATUSES,
  CORNER_WORK_LIVENESS_WINDOW_MS,
  CORNER_WORK_SIGNAL_TAGS,
  cornerLifecycleFact,
  cornerStatusPrecedence,
  isCornerNeedsYou,
  mapRawCornerStatusTag,
  mergeCornerStatuses,
  resolveCornerLifecycle,
  resolveCornerState,
  resolveCornerStatusAgainstArchive,
  type CornerLifecycleFact,
  type CornerLifecycleStatus,
  type CornerSuperState,
} from '@beeline/buzz-client';

import {
  cornerStatusPrecedence,
  resolveCornerStatusAgainstArchive,
  type CornerLifecycleStatus,
  type CornerSuperState,
} from '@beeline/buzz-client';

export type CornerStatus = CornerLifecycleStatus;

export type CornerSummary = {
  id: string;
  name: string;
  openerPubkey: string;
  /** The legacy word the transport derived the summary from. `null` means
   * idle-without-finishing — which may be merely quiet OR a fresh unanswered
   * agent question; `awaitingReply` distinguishes the two. Surfaces read the
   * super-state, not this. */
  status: CornerStatus | null;
  /** The corner waits on a person because its agent asked a question that
   * nothing has superseded while it was still fresh (`resolveCornerState`'s
   * fresh-ask rule) — the case whose legacy word is `null`. Deck tiering
   * reads this to keep an asked corner in NEEDS YOU while a merely-idle
   * stalled corner falls to IDLE. Absent = not an ask-wait. */
  awaitingReply?: boolean;
  /** The corner's agent is PROVABLY offline past its presence lease (every
   * agent presence record for the Room is outside `isAgentPresenceOnline`'s
   * 120s window), AND that fact changes the reading: the oracle's verdict was
   * idle, not needs-you. An ask held by a dead agent is not waiting on your
   * reply — it is a stalled session. Absent/undefined = unknown (no
   * presence read answered, or the agent is online) = behave exactly as
   * today. Only set when a reviewable change is NOT present: `open` corners
   * stay needs-you regardless of presence, because the artifact stands on
   * its own. */
  agentOffline?: boolean;
  createdAt?: number;
  /** Most recent activity timestamp seen for this corner (seconds); used to
   * pick the corner that's actually being worked on over a stale/empty one. */
  lastActivityAt?: number;
};

/**
 * Legacy oracle super-state retained only for the staged migration fallback.
 * New surfaces render `cornerVisualState`, the daemon's exact three-state
 * vocabulary, instead of treating an unknown/null verdict as attention.
 */
export function cornerSuperState(
  status: CornerStatus | null,
): Exclude<CornerSuperState, 'stalled'> {
  if (status === null) return 'needs-human';
  if (status === 'live') return 'working';
  if (status === 'merged' || status === 'archived') return 'finished';
  return 'needs-human';
}

/** Relative precedence that tolerates the oracle's `null` (idle-without-
 * finishing) verdict — it ranks as the least reportable worded state. */
export function cornerStatusPrecedenceOrNull(status: CornerStatus | null): number {
  return status === null ? Number.MAX_SAFE_INTEGER : cornerStatusPrecedence(status);
}

/** Corners still being actively worked on — the set that deserves a live
 * badge / sort-to-top treatment, as opposed to terminal or paused states.
 * The oracle's `null` (stalled) is not active work. */
export function isCornerActive(status: CornerStatus | null): boolean {
  return status === 'live' || status === 'needs-attention';
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
  return resolveCornerStatusAgainstArchive(known, confirmedArchived);
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

/** The one three-state vocabulary rendered by both corners and Rooms. */
export function cornerVisualState(
  status: CornerStatus | null,
  opts?: { awaitingReply?: boolean; agentOffline?: boolean },
): CornerVisualState {
  if (isCornerStalledOffline({ status, agentOffline: opts?.agentOffline })) return 'idle';
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
  corners: readonly Pick<CornerSummary, 'status' | 'awaitingReply' | 'agentOffline'>[],
): CornerVisualState {
  return corners.reduce<CornerVisualState>((current, corner) => {
    const next = cornerVisualState(corner.status, corner);
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
 * A corner whose agent is PROVABLY offline past its presence lease and that
 * holds no actionable artifact: the fallback oracle's stalled verdict. Such a corner
 * is never "waiting on you" — gold means something YOU can act on with a live
 * agent or a real artifact, and neither applies here. A reviewable change
 * (`open`) is exactly the real-artifact exception and stays needs-you.
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
 * A provably-offline agent's unfinished corner projects to the same IDLE state
 * vocabulary; the separate fact line may still explain that the agent is
 * offline without inventing another visible status.
 */
export function cornerStatusPresentation(
  status: CornerStatus | null,
  opts?: { awaitingReply?: boolean; agentOffline?: boolean },
): {
  glyph: string;
  label: string;
} {
  if (isCornerStalledOffline({ status, agentOffline: opts?.agentOffline })) {
    return { glyph: CORNER_GLYPH_HOLLOW, label: 'IDLE' };
  }
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
      cornerStatusPrecedenceOrNull(a.status) - cornerStatusPrecedenceOrNull(b.status);
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
  return corners.filter(
    (corner) => corner.status === null || ROOM_LIST_WORDED_STATUSES.has(corner.status),
  );
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
