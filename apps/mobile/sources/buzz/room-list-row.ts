import {
  cornerStatusPresentation,
  roomCornerSignal,
  roomListCorners,
  type CornerSummary,
  type CornerStatus,
} from '@/buzz/corners';
import { isMachinePreview } from '@/buzz/room-list-summary';
import { isRetiredAgentStateNotice } from '@/buzz/retired-agent-notices';

export type RoomListZone = 'needs-you' | 'working' | 'quiet';

export const ROOM_LIST_ZONE_LABELS: Record<RoomListZone, string> = {
  'needs-you': 'NEEDS YOU',
  working: 'WORKING',
  quiet: 'QUIET',
};

const ROOM_LIST_ZONE_ORDER: readonly RoomListZone[] = ['needs-you', 'working', 'quiet'];
const NEEDS_YOU_STATUSES: ReadonlySet<CornerStatus> = new Set([
  'needs-attention',
  'open',
  'failed',
]);
const MEANINGFUL_CORNER_STATUSES: ReadonlySet<CornerStatus> = new Set([
  ...NEEDS_YOU_STATUSES,
  'live',
  'merged',
]);
const LIVE_STATUSES: ReadonlySet<CornerStatus> = new Set(['live']);
const FINISHED_STATUSES: ReadonlySet<CornerStatus> = new Set(['merged']);

/**
 * Every presentational decision one Room row makes, derived once, off the
 * data the index already holds.
 *
 * It lives outside `channels.tsx` because these are the decisions worth
 * proving: which corners the count and the dropdown agree on, when the row is
 * genuinely *alive* (the single condition on this screen that spends gold),
 * and what the activity line says when nothing readable has been said. The
 * screen renders the answer; it does not re-derive it.
 */
export type RoomRowPresentation = {
  /**
   * The row's one leading mark. A Room reports corner state when it has
   * reportable corner work (`cornerStatusPresentation` stays the single source
   * of those glyphs), and otherwise reports whether it has been spoken in.
   */
  glyph: string;
  /**
   * An agent is working in this Room right now. DESIGN.md fixes gold to agent
   * identity, live/online presence, owner role, and merge approval; a live
   * Room is that same "an agent is alive here" meaning read at index scale, so
   * it is the only state on this screen that takes the accent.
   */
  live: boolean;
  /**
   * A corner is waiting on a person. The most action-worthy state here, and
   * deliberately *not* gold — it escalates on luminance (the brightest grey)
   * so gold keeps meaning exactly one thing.
   */
  attention: boolean;
  /**
   * The corners the count reports and the dropdown lists — the same set, from
   * the same filter, so the number can never advertise work that expanding
   * hides. Terminal corners (`merged`, `archived`) and `failed` ones are
   * excluded outright and stay reachable through the full corner list.
   */
  corners: CornerSummary[];
  /** Which of the three scan zones this Room belongs to. */
  zone: RoomListZone;
  /** Newest message or lifecycle event that should affect list ordering. */
  meaningfulAt: number;
  /** Current Room truth; only falls back to message text when no lifecycle fact exists. */
  fact: string;
};

/**
 * What the activity line says when a Room holds nothing a person can read —
 * either nothing has been said, or everything said was machine plumbing that
 * `roomPreviewText` refused to put on the index.
 */
export const NO_ACTIVITY_PREVIEW = 'Nothing said yet';

/**
 * A Room is *alive* when an agent is working in one of its corners right now.
 * The single condition the index spends gold on, exported so the section
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
};

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
  const zone: RoomListZone = needsYou ? 'needs-you' : working ? 'working' : 'quiet';
  // The stored preview was sanitized when it was written; this is the floor
  // for one written by an older build and still sitting in the local cache.
  const stored = room.latestMessage?.trim();
  const preview =
    stored && !isMachinePreview(stored) && !isRetiredAgentStateNotice(stored) ? stored : undefined;
  const messageAt = room.latestMessageAt ?? (preview ? room.updatedAt : undefined) ?? 0;
  const meaningfulAt = Math.max(
    messageAt,
    ...all.filter((corner) => MEANINGFUL_CORNER_STATUSES.has(corner.status)).map(cornerTimestamp),
    room.createdAt ?? 0,
  );
  return {
    glyph: currentCorner
      ? cornerStatusPresentation(currentCorner.status).glyph
      : preview
        ? '›'
        : '·',
    live: Boolean(working),
    attention: Boolean(needsYou),
    corners,
    zone,
    meaningfulAt,
    fact: currentCorner ? cornerFact(currentCorner, authorNames) : (preview ?? NO_ACTIVITY_PREVIEW),
  };
}

/**
 * Build the three non-empty index zones and sort every zone by its newest
 * meaningful event. This is deliberately the only Room ordering function the
 * screen consumes: lifecycle state, fact text, age, and placement all come
 * from the same projection.
 */
export function roomListSections<T extends RoomRowInput>(
  rooms: readonly T[],
  authorNames: ReadonlyMap<string, string>,
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
    };
  });
  return ROOM_LIST_ZONE_ORDER.flatMap((zone) => {
    const data = projected
      .filter((entry) => entry.row.zone === zone)
      .sort(
        (a, b) =>
          b.row.meaningfulAt - a.row.meaningfulAt ||
          (a.item.title ?? a.item.id ?? '').localeCompare(b.item.title ?? b.item.id ?? ''),
      );
    return data.length > 0 ? [{ zone, title: ROOM_LIST_ZONE_LABELS[zone], data }] : [];
  });
}
