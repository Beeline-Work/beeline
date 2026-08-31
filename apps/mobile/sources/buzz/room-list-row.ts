import {
  cornerName,
  cornerStatusPresentation,
  cornerSuperState,
  cornerVisualState,
  currentCornerStatus,
  isCornerStalledOffline,
  roomCornerSignal,
  roomListCorners,
  roomState,
  type CornerStatus,
  type CornerSummary,
  type CornerSuperState,
  type CornerVisualState,
} from '@/buzz/corners';
import { isMachinePreview } from '@/buzz/room-list-summary';
import { isRetiredAgentNotice } from '@beeline/buzz-client';

export type ExpandedCornerRefreshAction =
  | { kind: 'none' }
  | { kind: 'reload'; roomId: string }
  | { kind: 'drop'; roomId: string };

export function expandedCornerRefreshAction(
  expandedRoomId: string | null,
  chats: readonly { readonly room: { readonly id: string }; readonly cornerCount: number }[],
): ExpandedCornerRefreshAction {
  if (!expandedRoomId) return { kind: 'none' };
  const room = chats.find((chat) => chat.room.id === expandedRoomId);
  return room?.cornerCount
    ? { kind: 'reload', roomId: expandedRoomId }
    : { kind: 'drop', roomId: expandedRoomId };
}

/** The one state vocabulary used by both row projection and circle rendering. */
export type RoomListZone = 'needs-you' | 'working' | 'idle';

// Gold is the exact needs-you state, only when a person can act now.
// Affordance words per canonical projection stay contextual (reply / retry).
function needsYouAction(status: CornerStatus | null): string {
  const key = status === null ? 'needs-attention' : status;
  return NEEDS_YOU_ACTION[key] ?? 'REPLY';
}
const MEANINGFUL_CORNER_SUPERSTATES: ReadonlySet<CornerSuperState> = new Set([
  'needs-human',
  'working',
  'finished',
]);
const LIVE_STATUSES: ReadonlySet<CornerStatus> = new Set(['live']);
const FINISHED_STATUSES: ReadonlySet<CornerStatus> = new Set(['merged']);

/**
 * Whether this corner puts its Room in the pinned needs-you cluster. It is for
 * corners a person can act on RIGHT NOW — a decision/reply ask (`needs-attention`, or a fresh agent
 * question carried as `awaitingReply`), or a failure-stalled card (`failed`).
 * A merely idle corner — nothing fresh to answer — is
 * idle state, not attention; its nudge/close affordance still
 * lives inside the corner itself.
 *
 * Presence is deliberately absent from this decision. It may render as a
 * separate fact, but cannot rewrite canonical lifecycle.
 */
function needsYouCorner(corner: CornerSummary): boolean {
  return (
    Boolean(corner.machineState) &&
    cornerVisualState(currentCornerStatus(corner), {
      awaitingReply: corner.awaitingReply,
    }) === 'needs-you'
  );
}

/**
 * The one loud word a needs-you Room is allowed to say — the AFFORDANCE the
 * person gets on opening the corner (reply focus, retry, or nudge/close). The STATE word on every
 * surface is just needs-human; this names what to do about it.
 */
const NEEDS_YOU_ACTION: Record<string, string> = {
  'needs-attention': 'REPLY',
  failed: 'RETRY',
  stalled: 'NUDGE',
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
  /** MAX-severity rollup of the Room-own turn and every corner state. */
  state: CornerVisualState;
  /** Unread activity affects title weight and recency only, never state. */
  unread: boolean;
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
   * A corner is waiting on a person. Unread activity is deliberately separate.
   */
  attention: boolean;
  /**
   * The corners the count reports and the dropdown lists — the same set, from
   * the same filter, so the number can never advertise work that expanding
   * hides. Terminal corners (`merged`, `archived`) are excluded outright:
   * finished work is represented NOWHERE in navigation (no count, no
   * expansion, no pinned bar) per the owner's model — its history stays
   * reachable only through the transcript's landed/closed references.
   * Artifact-backed failures remain listed and actionable.
   */
  corners: CornerSummary[];
  /**
   * Formatted unread-count chip for the gutter's top slot, or `null` when the
   * row carries no unread messages (read rows keep their age stamp there).
   * An unread-but-uncountable Room reads `NEW` rather than an invented number,
   * and exact counts cap at `9+` so the fixed gutter never reflows. Derived
   * from message unread only — a live agent turn lifts the row but is not a
   * message, so it never produces a count.
   */
  unreadBadge: string | null;
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

/** Highest count shown exactly; anything more compacts so the chip stays one
 * small fixed object in the gutter (`9+`, never `12`). */
const UNREAD_BADGE_CAP = 9;

/** The chip label for one Room's unread state: exact count up to the cap,
 * `NEW` when the Room is unread but no local transcript can count against the
 * mark, and `null` when the row is read. Keyed on `roomUnread` (a message
 * newer than the read mark) — never on a live conversational turn. */
function unreadBadgeLabel(room: Pick<RoomRowInput, 'roomUnread' | 'unreadNew'>): string | null {
  if (!room.roomUnread) return null;
  const count = room.unreadNew;
  if (count == null || count <= 0) return 'NEW';
  if (count > UNREAD_BADGE_CAP) return `${UNREAD_BADGE_CAP}+`;
  return String(count);
}

/**
 * A Room is *alive* when an agent is working in one of its corners right now.
 * The single condition the index spends motion on, exported so every
 * consumer agrees about live corner work.
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
   * An unread message exists in the ROOM itself — agent OR human author, per
   * the owner's model (2026-08-23) — newer than the viewer's read
   * mark (`isRoomUnread` over the room's own latest-message summary; corners
   * never feed it). It bolds and floats the row but never changes state.
   */
  roomUnread?: boolean;
  /**
   * The newest durable lifecycle marker says an agent turn is working in this
   * Room's own conversation. Corner turns arrive independently through
   * `corners`; the row takes the maximum of both contributions.
   */
  agentTurnWorking?: boolean;
  /** Timestamp of the newest live Room turn event, in unix seconds. */
  agentTurnAt?: number;
};

function cornerTimestamp(corner: CornerSummary): number {
  return corner.lastActivityAt ?? corner.createdAt ?? 0;
}

function newestNeedsYou(corners: readonly CornerSummary[]): CornerSummary | undefined {
  return corners
    .filter(needsYouCorner)
    .sort(
      (a, b) =>
        cornerTimestamp(b) - cornerTimestamp(a) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    )[0];
}

/** Newest corner whose provably-offline agent left it unfinished and
 * unactionable — the STALLED fact an honest deck reports without golding it. */
function newestStalledOffline(corners: readonly CornerSummary[]): CornerSummary | undefined {
  return corners
    .filter(
      (corner) =>
        Boolean(corner.machineState) &&
        isCornerStalledOffline({ ...corner, status: currentCornerStatus(corner) }),
    )
    .sort(
      (a, b) =>
        cornerTimestamp(b) - cornerTimestamp(a) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    )[0];
}

/** Newest corner carrying one of the given canonical projections. */
function newestByStatus(
  corners: readonly CornerSummary[],
  statuses: ReadonlySet<CornerStatus>,
): CornerSummary | undefined {
  return corners
    .filter((corner) => {
      if (!corner.machineState) return false;
      const status = currentCornerStatus(corner);
      return status !== null && statuses.has(status);
    })
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
  // The state circle already carries idle/working/needs-you. The fact line is
  // narrative only, never a second visible status label. Offline remains an
  // explicit preserved fact because it explains why a wait was demoted.
  const status = currentCornerStatus(corner);
  if (isCornerStalledOffline({ ...corner, status })) {
    return `Agent offline · ${corner.name}`;
  }
  switch (cornerSuperState(status)) {
    case 'working':
      return `${actorName(corner, authorNames, 'Agent')} · ${corner.name}`;
    case 'needs-human':
      return corner.name;
    case 'finished':
      return status === 'merged'
        ? `${actorName(corner, authorNames, 'Change')} · landed · ${corner.name}`
        : NO_ACTIVITY_PREVIEW;
  }
}

export function roomRowPresentation(
  room: RoomRowInput,
  authorNames: ReadonlyMap<string, string>,
): RoomRowPresentation {
  const all = room.corners ?? [];
  const corners = roomListCorners(all);
  const needsYou = newestNeedsYou(all);
  const working = newestByStatus(all, LIVE_STATUSES);
  const stalledOffline = newestStalledOffline(all);
  const finished = newestByStatus(all, FINISHED_STATUSES);
  // Precedence: what YOU can act on, then live work, then the honest
  // offline-stalled fact, then finished history.
  const currentCorner = needsYou ?? working ?? stalledOffline ?? finished;
  const unreadHere = Boolean(room.roomUnread || room.agentTurnWorking);
  const cornerState = roomState(all);
  // One verdict, maximum severity: a person-actionable corner outranks all
  // work; otherwise either a Room-own turn or a working corner earns motion.
  // Completion removes only the Room-own contribution and cannot demote an
  // independently urgent corner.
  const state: CornerVisualState =
    cornerState === 'needs-you'
      ? 'needs-you'
      : room.agentTurnWorking || cornerState === 'working'
        ? 'working'
        : 'idle';
  const zone: RoomListZone = state;
  // The stored preview was sanitized when it was written; this is the floor
  // for one written by an older build and still sitting in the local cache —
  // git/tool plumbing (`isMachinePreview`) and retired daemon prose
  // (`isRetiredAgentNotice`, including the bounded attachment-ENOENT and
  // model-unavailable shapes) alike. A relay event cannot be unpublished, so
  // an old wall must never reach this row just because it predates the fix.
  const stored = room.latestMessage?.trim();
  const clean =
    stored && !isMachinePreview(stored) && !isRetiredAgentNotice(stored) ? stored : undefined;
  const messageAt = room.latestMessageAt ?? (clean ? room.updatedAt : undefined) ?? 0;
  const meaningfulAt = Math.max(
    messageAt,
    ...all
      .filter(
        (corner) =>
          Boolean(corner.machineState) &&
          MEANINGFUL_CORNER_SUPERSTATES.has(cornerSuperState(currentCornerStatus(corner))),
      )
      .map(cornerTimestamp),
    room.agentTurnAt ?? 0,
    room.createdAt ?? 0,
  );
  // The deck attributes idle previews with the same roster the lifecycle facts
  // use ("you · let's ship it"), so a quiet row reads as history, not noise.
  const speaker = room.latestMessageAuthor
    ? (authorNames.get(room.latestMessageAuthor)?.trim() ?? undefined)
    : undefined;
  const previewFact = clean && speaker ? `${speaker} · ${clean}` : clean;
  const pills: RoomRowPill[] = [];
  if (needsYou) {
    pills.push({ kind: 'status', label: needsYouAction(currentCornerStatus(needsYou)) });
  }
  if (room.modelLabel) pills.push({ kind: 'model', label: room.modelLabel });
  if (corners.length > 0) {
    pills.push({
      kind: 'corner',
      label: `${corners.length} corner${corners.length === 1 ? '' : 's'} open`,
    });
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
    state,
    unread: unreadHere,
    glyph: cornerStatusPresentation(
      state === 'working' ? 'live' : state === 'needs-you' ? 'needs-attention' : null,
    ).glyph,
    live: Boolean(room.agentTurnWorking || working),
    attention: state === 'needs-you',
    corners,
    unreadBadge: unreadBadgeLabel(room),
    zone,
    meaningfulAt,
    fact: currentCorner
      ? cornerFact(currentCorner, authorNames)
      : (previewFact ?? NO_ACTIVITY_PREVIEW),
    pills,
  };
}

type RankedEntry<T extends RoomRowInput> = { item: T; row: RoomRowPresentation };

function byRecency<T extends RoomRowInput>(a: RankedEntry<T>, b: RankedEntry<T>): number {
  return b.row.meaningfulAt - a.row.meaningfulAt;
}

function projectEntries<T extends RoomRowInput>(
  rooms: readonly T[],
  authorNames: ReadonlyMap<string, string>,
): Array<RankedEntry<T>> {
  const titleCounts = new Map<string, number>();
  for (const item of rooms) {
    const title = item.title?.trim().toLocaleLowerCase();
    if (title) titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
  }
  return rooms.map((item) => {
    const row = roomRowPresentation(item, authorNames);
    const title = item.title?.trim().toLocaleLowerCase();
    const duplicateTitle = title ? (titleCounts.get(title) ?? 0) > 1 : false;
    const displayItem =
      duplicateTitle && item.id && item.title
        ? { ...item, title: `${item.title} · ID ${item.id.slice(0, 8)}` }
        : item;
    return { item: displayItem, row };
  });
}

/**
 * Captain's channel-mark convention (2026-08): Room index rows display
 * `#<name>`. Extended across every surface that exposes a room or corner
 * name (2026-08): chat headers, breadcrumbs, the pinned-corner line, corner
 * lists, Workspace settings, and Members references all render through this
 * derivation or `displayCornerTitle` below. Strictly presentation — the
 * stored name, search keys, sorting, unread state, navigation params, cache
 * writes, and identity never see the prefix. A Room whose title fell back to
 * the placeholder id gains no mark: nothing fabricated is decorated.
 */
export function displayRoomIndexTitle(storedTitle: string | undefined): string | undefined {
  const trimmed = storedTitle?.trim();
  if (!trimmed) return undefined;
  // Idempotent: a name that already carries the mark is never double-prefixed.
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
}

/**
 * The corner half of the same convention: a corner renders as
 * `#<room>/<corner>`, composed from STORED names at render time. When the
 * parent Room's name has not resolved yet the corner still gets its own mark
 * (`#<corner>`) rather than blocking the label — honest about what is known.
 *
 * Presentation-only like `displayRoomIndexTitle`: nothing here mutates a
 * stored name, a navigation param, or a cache entry. Leading marks on either
 * stored part are stripped before composing, so an already-decorated name can
 * never double-prefix. A missing corner name falls through `cornerName`'s own
 * id-slug fallback so the label is never empty.
 */
export function displayCornerTitle(
  parentRoomName: string | undefined | null,
  cornerStoredName: string | undefined,
  cornerId: string,
): string {
  const corner = cornerName(cornerStoredName, cornerId);
  const room = parentRoomName?.trim().replace(/^#+/, '');
  return room ? `#${room}/${corner}` : `#${corner}`;
}

/**
 * Build the one headerless feed. Needs-you Rooms cluster first; each cluster
 * is newest-activity first. Unread and live Room turns affect recency/weight,
 * never state. Native stable sort preserves source order for exact ties.
 *
 * This is deliberately the only ordering function the screen consumes for its
 * feed: lifecycle state, fact text, age, and placement all come from the same
 * projection. Live Room turns contribute working state and recency; message
 * unread contributes recency/weight only. (`options.now` remains accepted for
 * call-site stability; zoning no longer depends on wall-clock buckets.)
 */
export function roomListFeed<T extends RoomRowInput>(
  rooms: readonly T[],
  authorNames: ReadonlyMap<string, string>,
  _options: { now?: number } = {},
): Array<RankedEntry<T>> {
  return projectEntries(rooms, authorNames).sort((a, b) => {
    const attentionDelta =
      Number(b.row.state === 'needs-you') - Number(a.row.state === 'needs-you');
    return attentionDelta || byRecency(a, b);
  });
}
