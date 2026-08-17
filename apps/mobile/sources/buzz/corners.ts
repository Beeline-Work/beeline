/**
 * Single canonical corner lifecycle model. Every surface that shows a corner's
 * status — the Room-list dropdown, the in-Room corner card, the standalone
 * Corners list, and the corner view itself — reads this same `CornerStatus`
 * and presents it through `cornerStatusPresentation`. There is no second,
 * parallel status vocabulary: raw wire tags from body-control events are
 * translated into this type exactly once, via `mapRawCornerStatusTag`.
 */
export type CornerStatus = 'live' | 'needs-attention' | 'open' | 'failed' | 'merged' | 'archived';

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

const STATUS_ORDER: Record<CornerStatus, number> = {
  live: 0,
  'needs-attention': 1,
  open: 2,
  failed: 3,
  merged: 4,
  archived: 5,
};

/** Monotonic precedence guard: never let an out-of-order real-time event walk
 * a corner's displayed status backwards (e.g. a stale "live" arriving after
 * "failed"). Shared by the live message-upsert path. */
export function cornerStatusPrecedence(status: CornerStatus): number {
  return STATUS_ORDER[status];
}

/** Corners still being actively worked on — the set that deserves a live
 * badge / sort-to-top treatment, as opposed to terminal or paused states. */
export function isCornerActive(status: CornerStatus): boolean {
  return status === 'live' || status === 'needs-attention';
}

/**
 * A corner view's own archived confirmation (`isChannelArchived` / a live
 * archive signal) is fetched independently of, and can resolve after, its
 * last known lifecycle-status snapshot (`listSubchannelLifecycle`, fetched
 * once at mount). Once the channel is confirmed archived, never keep
 * displaying a stale non-terminal snapshot — apply the same precedence used
 * to keep a corner's displayed status from walking backwards elsewhere.
 */
export function resolveCornerLifecycleStatus(
  known: CornerStatus | null,
  confirmedArchived: boolean,
): CornerStatus | null {
  if (!confirmedArchived) return known;
  if (!known || cornerStatusPrecedence('archived') >= cornerStatusPrecedence(known)) return 'archived';
  return known;
}

/** Translate a raw `display-status`/`status` wire tag value into the one
 * canonical status. This is the single place that vocabulary conversion
 * happens — nothing downstream should re-derive status from raw tags. */
export function mapRawCornerStatusTag(raw: string | undefined): CornerStatus | undefined {
  switch (raw) {
    case 'starting':
    case 'working':
    case 'open':
    case 'live':
      return 'live';
    case 'needs-attention':
      return 'needs-attention';
    case 'ready':
      return 'open';
    case 'failed':
      return 'failed';
    case 'merged':
      return 'merged';
    case 'archived':
      return 'archived';
    default:
      return undefined;
  }
}

export function cornerName(name: string | undefined, id: string): string {
  const candidate = name?.trim().replace(/^#+/, '').replace(/\s+/g, '-');
  if (!candidate || candidate.startsWith('sub-')) return `corner-${id.slice(0, 8)}`;
  return candidate;
}

export function cornerStatusPresentation(status: CornerStatus): {
  glyph: string;
  label: string;
} {
  switch (status) {
    case 'live':
      return { glyph: '◆', label: 'LIVE' };
    case 'needs-attention':
      return { glyph: '▲', label: 'NEEDS ATTENTION' };
    case 'open':
      return { glyph: '◇', label: 'OPEN' };
    case 'failed':
      return { glyph: '✕', label: 'FAILED' };
    case 'merged':
      return { glyph: '✓', label: 'MERGED' };
    case 'archived':
      return { glyph: '□', label: 'ARCHIVED' };
  }
}

export function sortCorners(corners: CornerSummary[]): CornerSummary[] {
  return [...corners].sort((a, b) => {
    const statusDelta = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
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

/**
 * Pick the corner a "view corner" affordance should open when several exist:
 * the most recently active one among those still actively worked on, falling
 * back to the most recently active overall (never a stale/empty corner ahead
 * of one with real turns). `signals` may contain several entries per corner
 * (one per status update); only the latest per subchannel is considered.
 */
export function selectMostRecentActiveCornerId(
  signals: CornerActivitySignal[],
): string | undefined {
  const latestBySubchannel = new Map<string, CornerActivitySignal>();
  for (const signal of signals) {
    const existing = latestBySubchannel.get(signal.subchannelId);
    if (!existing || signal.timestamp >= existing.timestamp) {
      latestBySubchannel.set(signal.subchannelId, signal);
    }
  }
  const candidates = [...latestBySubchannel.values()];
  const active = candidates.filter((candidate) => isCornerActive(candidate.status));
  const pool = active.length > 0 ? active : candidates;
  return [...pool].sort((a, b) => b.timestamp - a.timestamp)[0]?.subchannelId;
}
