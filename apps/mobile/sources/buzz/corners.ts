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
  CORNER_NEEDS_YOU_STATUSES,
  CORNER_WORK_SIGNAL_TAGS,
  cornerLifecycleFact,
  cornerStatusPrecedence,
  isCornerNeedsYou,
  mapRawCornerStatusTag,
  mergeCornerStatuses,
  resolveCornerLifecycle,
  resolveCornerStatusAgainstArchive,
  type CornerLifecycleFact,
  type CornerLifecycleStatus,
} from '@beeline/buzz-client';

import {
  cornerStatusPrecedence,
  resolveCornerStatusAgainstArchive,
  type CornerLifecycleStatus,
} from '@beeline/buzz-client';

export type CornerStatus = CornerLifecycleStatus;

export type CornerSummary = {
  id: string;
  name: string;
  openerPubkey: string;
  status: CornerStatus;
  createdAt?: number;
  /** Most recent activity timestamp seen for this corner (seconds); used to
   * pick the corner that's actually being worked on over a stale/empty one. */
  lastActivityAt?: number;
};

/** Corners still being actively worked on — the set that deserves a live
 * badge / sort-to-top treatment, as opposed to terminal or paused states. */
export function isCornerActive(status: CornerStatus): boolean {
  return status === 'live' || status === 'needs-attention';
}

/**
 * A corner whose life is over: it landed, it failed, or it was closed. Nothing
 * that reports *current* work may ever name one of these — the pinned corner
 * line above the composer least of all, since it is tappable and a terminal
 * corner is a read-only channel a tap strands the reader in. Written as the
 * complement of the three terminal words rather than as an allowlist of live
 * ones so a new non-terminal `CornerStatus` is reportable by default, and a
 * new terminal one has to be named here to become terminal.
 */
export function isCornerTerminal(status: CornerStatus): boolean {
  return status === 'merged' || status === 'failed' || status === 'archived';
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
 * The ONE corner-state glyph family: diamonds. Corners are WORK, not
 * identities — shapes are identity vocabulary (`identity-mark.ts`: △ agent,
 * ○ human, ▢ workspace), so a corner's own glyph may never be an identity
 * shape, and the triangle appears next to a corner ONLY as the acting agent's
 * identity mark. Filled ◆ means live work; hollow ◇ covers every other state
 * — the label carries the word, the fill carries liveness.
 */
const CORNER_GLYPH_LIVE = '◆';
const CORNER_GLYPH_QUIET = '◇';

export function cornerGlyphForStatus(status: CornerStatus): string {
  return status === 'live' ? CORNER_GLYPH_LIVE : CORNER_GLYPH_QUIET;
}

export { CORNER_GLYPH_LIVE, CORNER_GLYPH_QUIET };

export function cornerStatusPresentation(status: CornerStatus): {
  glyph: string;
  label: string;
} {
  switch (status) {
    case 'live':
      return { glyph: CORNER_GLYPH_LIVE, label: 'LIVE' };
    case 'needs-attention':
      return { glyph: CORNER_GLYPH_QUIET, label: 'NEEDS ATTENTION' };
    case 'open': {
      // The only path to this status (`cornerSummaryFromEvents` in
      // `buzz-rig-transport.ts`) is a `ready` display-status or a
      // `merge-ready` tagged event — 'open' never means merely "not yet
      // closed", it always means the corner has an approvable change.
      return { glyph: CORNER_GLYPH_QUIET, label: 'READY' };
    }
    case 'failed':
      return { glyph: CORNER_GLYPH_QUIET, label: 'FAILED' };
    case 'merged':
      return { glyph: CORNER_GLYPH_QUIET, label: 'MERGED' };
    case 'archived':
      return { glyph: CORNER_GLYPH_QUIET, label: 'ARCHIVED' };
  }
}

export function sortCorners(corners: CornerSummary[]): CornerSummary[] {
  return [...corners].sort((a, b) => {
    const statusDelta = cornerStatusPrecedence(a.status) - cornerStatusPrecedence(b.status);
    if (statusDelta !== 0) return statusDelta;
    return (
      (b.lastActivityAt ?? b.createdAt ?? 0) - (a.lastActivityAt ?? a.createdAt ?? 0) ||
      a.name.localeCompare(b.name)
    );
  });
}

/**
 * The Room-list dropdown is a live-work shortcut, so it lists *only* corners
 * still open or actively being worked. Terminal corners — `merged`,
 * `archived` — and `failed` ones are excluded outright rather than shown
 * dimmed: a Room row's corner count must equal what the dropdown reveals, and
 * a count that includes rows a person cannot act on turns the index into a
 * to-do list of dead work.
 *
 * Excluded corners stay reachable through their durable cards in the parent
 * Room transcript and through the full `buzz/corners/[roomId]` list, which the
 * expanded dropdown links to. The allowlist is written out per status on
 * purpose: adding a new `CornerStatus` should force a decision here rather
 * than silently leaking into the index.
 */
const ROOM_LIST_STATUSES: ReadonlySet<CornerStatus> = new Set<CornerStatus>([
  'live',
  'needs-attention',
  'open',
]);

export function roomListCorners(corners: readonly CornerSummary[]): CornerSummary[] {
  return corners.filter((corner) => ROOM_LIST_STATUSES.has(corner.status));
}

/**
 * The single status a Room row's leading glyph reports, or `null` when no
 * corner needs reporting. Derived from the same set the dropdown shows, so the
 * glyph can never advertise work the row's own count and dropdown hide.
 */
export function roomCornerSignal(corners: readonly CornerSummary[]): CornerStatus | null {
  const listed = roomListCorners(corners);
  if (listed.length === 0) return null;
  const leading = listed.reduce((best, corner) =>
    cornerStatusPrecedence(corner.status) < cornerStatusPrecedence(best.status) ? corner : best,
  );
  return isCornerActive(leading.status) ? leading.status : null;
}

export type CornerActivitySignal = {
  subchannelId: string;
  status: CornerStatus;
  timestamp: number;
};
