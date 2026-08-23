import {
  CORNER_NEEDS_YOU_STATUSES,
  cornerStatusPresentation,
  roomCornerSignal,
  roomListCorners,
  type CornerSummary,
  type CornerStatus,
} from '@/buzz/corners';
import { isMachinePreview } from '@/buzz/room-list-summary';
import { isRetiredAgentStateNotice } from '@/buzz/retired-agent-notices';

export type RoomListZone = 'needs-you' | 'working' | 'idle';

export const ROOM_LIST_ZONE_LABELS: Record<RoomListZone, string> = {
  'needs-you': 'NEEDS YOU',
  working: 'WORKING',
  idle: 'IDLE',
};

const ROOM_LIST_ZONE_ORDER: readonly RoomListZone[] = ['needs-you', 'working', 'idle'];
// The needs-you set is THE one definition (`corners.ts`): the deck's gold zone
// and the corner view's attention card must never disagree about what counts.
const NEEDS_YOU_STATUSES = CORNER_NEEDS_YOU_STATUSES;
const MEANINGFUL_CORNER_STATUSES: ReadonlySet<CornerStatus> = new Set([
  ...NEEDS_YOU_STATUSES,
  'live',
  'merged',
]);
const LIVE_STATUSES: ReadonlySet<CornerStatus> = new Set(['live']);
const FINISHED_STATUSES: ReadonlySet<CornerStatus> = new Set(['merged']);

/**
 * The one loud word a needs-you Room is allowed to say. Each maps from the
 * corner lifecycle state that put the Room in the zone, so the pill can never
 * advertise an action the underlying state does not offer.
 */
const NEEDS_YOU_ACTION: Record<Exclude<CornerStatus, 'live' | 'merged' | 'archived'>, string> = {
  open: 'APPROVE',
  'needs-attention': 'DECIDE',
  failed: 'BLOCKED',
};

/**
 * One quiet micro-label on a Room row's pill strip. Every kind has its own
 * mono style; only `status` (needs-you) may take the accent — the deck's
 * whole point is that brass appears nowhere else.
 */
export type RoomRowPill =
  | { kind: 'status'; label: string }
  | { kind: 'model'; label: string }
  | { kind: 'corner'; label: string }
  | { kind: 'people'; label: string }
  | { kind: 'unread'; label: string };

/**
 * Every presentational decision one Room row makes, derived once, off the
 * data the index already holds.
 *
 * It lives outside `channels.tsx` because these are the decisions worth
 * proving: which corners the count and the dropdown agree on, which of the
 * deck's three states the row is in (and that the precedence between them is
 * needs-you > working > idle), and what the activity line says when nothing
 * readable has been said. The screen renders the answer; it does not
 * re-derive it.
 */
export type RoomRowPresentation = {
  /**
   * The row's one leading mark glyph. A Room reports corner state when it has
   * reportable corner work (`cornerStatusPresentation` stays the single source
   * of those glyphs), and otherwise reports whether it has been spoken in.
   * The supervision deck renders the mark as motion/brass/steel per zone; the
   * tablet sidebar still reads this glyph.
   */
  glyph: string;
  /**
   * An agent is working in this Room right now. On the deck this row's mark
   * is MOTION (a spinner), never color.
   */
  live: boolean;
  /**
   * A corner is waiting on a person. The most action-worthy state on the
   * deck, and the ONLY state that spends the accent: brass dot, brass action
   * pill, brass activity line.
   */
  attention: boolean;
  /**
   * The corners the count reports and the dropdown lists — the same set, from
   * the same filter, so the number can never advertise work that expanding
   * hides. Terminal corners (`merged`, `archived`) and `failed` ones are
   * excluded outright and stay reachable through the full corner list.
   */
  corners: CornerSummary[];
  /**
   * Every corner the Room is known to hold, terminal ones included. The
   * dropdown's control must exist whenever a Room has ANY recorded corner:
   * gating it on open work alone left Rooms whose corners had all landed,
   * failed, or been closed with no affordance at all — the ALL CORNERS link
   * lived inside the expanded dropdown, so the row lost its only path to
   * corner navigation. The count still reports open work only (the captain's
   * hard requirement); this field decides visibility, not the number.
   */
  totalCorners: number;
  /** Which of the three scan zones this Room belongs to. */
  zone: RoomListZone;
  /** Newest message or lifecycle event that should affect list ordering. */
  meaningfulAt: number;
  /** Current Room truth; only falls back to message text when no lifecycle fact exists. */
  fact: string;
  /**
   * The row's pill strip, in display order. Derived here — not in the screen —
   * so the brass rule (only `kind: 'status'`) can be tested once.
   */
  pills: RoomRowPill[];
};

/**
 * What the activity line says when a Room holds nothing a person can read —
 * either nothing has been said, or everything said was machine plumbing that
 * `roomPreviewText` refused to put on the index.
 */
export const NO_ACTIVITY_PREVIEW = 'Nothing said yet';

/**
 * A Room is *alive* when an agent is working in one of its corners right now.
 * The single condition the index spends motion on, exported so the section
 * heading's LIVE count and the rows it heads can never disagree about it.
 */
export function isRoomAlive(corners: readonly CornerSummary[] | undefined): boolean {
  return roomCornerSignal(corners ?? []) === 'live';
}

export type RoomRowInput = {
  id?: string;
  title?: string;
  archived?: boolean;
  corners?: readonly CornerSummary[];
  latestMessage?: string;
  latestMessageAt?: number;
  latestMessageAuthor?: string;
  updatedAt?: number;
  createdAt?: number;
  /** Repository bound to the Room (`binding.name`), when one resolves. */
  repoName?: string;
  /** Model id of the Room's first configured agent, when one publishes a catalog. */
  modelLabel?: string;
  /** People+agents currently in the Room ("N here"). */
  participantCount?: number;
  /**
   * Unread conversational messages, when the local transcript can count them;
   * `null` means "unread but uncountable" (still shown, without a number).
   */
  unreadNew?: number | null;
  /**
   * An agent turn is streaming in this Room's own conversation right now —
   * seen live by the index's event subscription. Corner turns arrive through
   * `corners`; this carries the read-only conversational turn.
   */
  agentTurnWorking?: boolean;
};

/** Recency headings for idle rooms, oldest last. Deliberately coarse. */
const QUIET_BUCKETS: readonly { title: string; maxAgeMs: number }[] = [
  { title: 'TODAY', maxAgeMs: Number.POSITIVE_INFINITY },
  { title: 'YESTERDAY', maxAgeMs: 24 * 60 * 60 * 1000 },
  { title: 'EARLIER', maxAgeMs: Number.POSITIVE_INFINITY },
];

export type RoomListSection<T extends RoomRowInput> = {
  zone: RoomListZone;
  title: string;
  data: Array<{ item: T; row: RoomRowPresentation }>;
};

function cornerTimestamp(corner: CornerSummary): number {
  return corner.lastActivityAt ?? corner.createdAt ?? 0;
}

function newestCorner(
  corners: readonly CornerSummary[],
  statuses: ReadonlySet<CornerStatus>,
): CornerSummary | undefined {
  return corners
    .filter((corner) => statuses.has(corner.status))
    .sort(
      (a, b) =>
        cornerTimestamp(b) - cornerTimestamp(a) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    )[0];
}

function actorName(
  corner: CornerSummary,
  authorNames: ReadonlyMap<string, string>,
  fallback: string,
): string {
  return authorNames.get(corner.openerPubkey)?.trim() || fallback;
}

function cornerFact(corner: CornerSummary, authorNames: ReadonlyMap<string, string>): string {
  switch (corner.status) {
    case 'live':
      return `${actorName(corner, authorNames, 'Agent')} working · ${corner.name}`;
    case 'needs-attention':
      return `${actorName(corner, authorNames, 'Change')} · decision needed · ${corner.name}`;
    case 'open':
      return `${actorName(corner, authorNames, 'Change')} · ready for review · ${corner.name}`;
    case 'failed':
      return `${actorName(corner, authorNames, 'Change')} · failed · ${corner.name}`;
    case 'merged':
      return `${actorName(corner, authorNames, 'Change')} · landed · ${corner.name}`;
    case 'archived':
      return NO_ACTIVITY_PREVIEW;
  }
}

function needsYouAction(status: CornerStatus): string {
  return NEEDS_YOU_ACTION[status as keyof typeof NEEDS_YOU_ACTION];
}

export function roomRowPresentation(
  room: RoomRowInput,
  authorNames: ReadonlyMap<string, string>,
): RoomRowPresentation {
  const all = room.corners ?? [];
  const corners = roomListCorners(all);
  const needsYou = newestCorner(all, NEEDS_YOU_STATUSES);
  const working = newestCorner(all, LIVE_STATUSES);
  const finished = newestCorner(all, FINISHED_STATUSES);
  const currentCorner = needsYou ?? working ?? finished;
  const turnWorking = Boolean(room.agentTurnWorking) && !needsYou;
  const zone: RoomListZone = needsYou
    ? 'needs-you'
    : working || turnWorking
      ? 'working'
      : 'idle';
  // The stored preview was sanitized when it was written; this is the floor
  // for one written by an older build and still sitting in the local cache.
  const stored = room.latestMessage?.trim();
  const clean =
    stored && !isMachinePreview(stored) && !isRetiredAgentStateNotice(stored)
      ? stored
      : undefined;
  const messageAt = room.latestMessageAt ?? (clean ? room.updatedAt : undefined) ?? 0;
  const meaningfulAt = Math.max(
    messageAt,
    ...all.filter((corner) => MEANINGFUL_CORNER_STATUSES.has(corner.status)).map(cornerTimestamp),
    room.createdAt ?? 0,
  );
  // The deck attributes idle previews with the same roster the lifecycle facts
  // use ("you · let's ship it"), so a quiet row reads as history, not noise.
  const speaker = room.latestMessageAuthor
    ? (authorNames.get(room.latestMessageAuthor)?.trim() ?? undefined)
    : undefined;
  const previewFact = clean && speaker ? `${speaker} · ${clean}` : clean;
  const pills: RoomRowPill[] = [];
  if (needsYou) pills.push({ kind: 'status', label: needsYouAction(needsYou.status) });
  if (room.modelLabel) pills.push({ kind: 'model', label: room.modelLabel });
  if (corners.length > 0) {
    pills.push({ kind: 'corner', label: `${corners.length} corner${corners.length === 1 ? '' : 's'} open` });
  }
  if ((room.participantCount ?? 0) > 0) {
    pills.push({ kind: 'people', label: `${room.participantCount} here` });
  }
  if (room.unreadNew == null) {
    if (room.unreadNew === null) {
      // Unread but uncountable (no local transcript to count against).
      pills.push({ kind: 'unread', label: 'new' });
    }
  } else if (room.unreadNew > 0) {
    pills.push({ kind: 'unread', label: `${room.unreadNew} new` });
  }
  return {
    glyph: currentCorner
      ? cornerStatusPresentation(currentCorner.status).glyph
      : clean
        ? '›'
        : '·',
    live: Boolean(working) || turnWorking,
    attention: Boolean(needsYou),
    corners,
    totalCorners: all.length,
    zone,
    meaningfulAt,
    fact: currentCorner
      ? cornerFact(currentCorner, authorNames)
      : (previewFact ?? NO_ACTIVITY_PREVIEW),
    pills,
  };
}

/**
 * Build the deck's sections: Needs you first, then Working, then idle rooms
 * grouped by recency (Today / Yesterday / Earlier). This is deliberately the
 * only Room ordering function the screen consumes: lifecycle state, fact text,
 * age, and placement all come from the same projection.
 */
export function roomListSections<T extends RoomRowInput>(
  rooms: readonly T[],
  authorNames: ReadonlyMap<string, string>,
  options: { now?: number } = {},
): RoomListSection<T>[] {
  const visibleRooms = rooms.filter((item) => !item.archived);
  const titleCounts = new Map<string, number>();
  for (const item of visibleRooms) {
    const title = item.title?.trim().toLocaleLowerCase();
    if (title) titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
  }
  const projected = visibleRooms.map((item) => {
    const row = roomRowPresentation(item, authorNames);
    const title = item.title?.trim().toLocaleLowerCase();
    const duplicateTitle = title ? (titleCounts.get(title) ?? 0) > 1 : false;
    const displayItem =
      duplicateTitle && item.id && item.title
        ? { ...item, title: `${item.title} · ID ${item.id.slice(0, 8)}` }
        : item;
    return {
      item: displayItem,
      row,
      bucket: row.zone === 'idle' ? quietBucket(row.meaningfulAt, options.now ?? Date.now()) : -1,
    };
  });
  const byRecency = (
    a: { item: T; row: RoomRowPresentation },
    b: { item: T; row: RoomRowPresentation },
  ) =>
    b.row.meaningfulAt - a.row.meaningfulAt ||
    (a.item.title ?? a.item.id ?? '').localeCompare(b.item.title ?? b.item.id ?? '');
  const sections: RoomListSection<T>[] = [];
  for (const zone of ROOM_LIST_ZONE_ORDER) {
    if (zone !== 'idle') {
      const data = projected.filter((entry) => entry.row.zone === zone).sort(byRecency);
      if (data.length > 0) sections.push({ zone, title: ROOM_LIST_ZONE_LABELS[zone], data });
      continue;
    }
    for (let bucket = 0; bucket < QUIET_BUCKETS.length; bucket += 1) {
      const data = projected
        .filter((entry) => entry.row.zone === 'idle' && entry.bucket === bucket)
        .sort(byRecency);
      if (data.length > 0) {
        sections.push({ zone, title: QUIET_BUCKETS[bucket].title, data });
      }
    }
  }
  return sections;
}

/** Which recency heading an idle room belongs under. `-1` = not idle. */
function quietBucket(meaningfulAtSeconds: number, nowMs: number): number {
  const startOfToday = new Date(nowMs);
  startOfToday.setHours(0, 0, 0, 0);
  const at = meaningfulAtSeconds * 1000;
  if (at >= startOfToday.getTime()) return 0;
  if (at >= startOfToday.getTime() - QUIET_BUCKETS[1].maxAgeMs) return 1;
  return 2;
}
