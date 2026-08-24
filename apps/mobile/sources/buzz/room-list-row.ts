import {
  cornerStatusPresentation,
  cornerSuperState,
  isCornerStalledOffline,
  isCornerTerminal,
  roomCornerSignal,
  roomListCorners,
  type CornerStatus,
  type CornerSummary,
  type CornerSuperState,
} from '@/buzz/corners';
import { isMachinePreview } from '@/buzz/room-list-summary';
import { isRetiredAgentStateNotice } from '@/buzz/retired-agent-notices';

/** A row's deck state. Working is a ROW state only (the mark's motion) — the
 * owner's two-tier deck folds working rooms into the IDLE section, so a
 * working room carries no top-level tier of its own. */
export type RoomListZone = 'needs-you' | 'working' | 'idle';

/** The deck's SECTION tiers: NEEDS YOU, then IDLE (everything not waiting on
 * the human). Finished Rooms are reachable only through the collapsed entry. */
export type RoomDeckTier = Exclude<RoomListZone, 'working'>;

export const ROOM_LIST_ZONE_LABELS: Record<RoomDeckTier, string> = {
  'needs-you': 'NEEDS YOU',
  idle: 'IDLE',
};

const ROOM_LIST_TIER_ORDER: readonly RoomDeckTier[] = ['needs-you', 'idle'];
// Gold is THE three-word verdict's needs-human state — but only its
// ACTIONABLE half reaches the NEEDS YOU tier (see `needsYouCorner`).
// Affordance words per legacy word stay contextual (approve card / reply /
// retry).
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
 * Whether this corner puts its Room in the NEEDS YOU tier. Owner refinement:
 * NEEDS YOU is for corners a person can act on RIGHT NOW — a review-ready
 * change (`open`), a decision/reply ask (`needs-attention`, or a fresh agent
 * question carried as `awaitingReply`), or a failure-stalled card (`failed`).
 * A merely idle corner — nothing fresh to answer, nothing new to approve — is
 * IDLE deck state, not attention; its nudge/close affordance still lives
 * inside the corner itself.
 *
 * Presence refinement (owner report 2026-08-23): a PROVABLY offline agent's
 * ask/needs-attention card is not waiting on your reply — nobody is there to
 * receive it. Gold means something YOU can act on with a live agent or a real
 * artifact, so an offline-stalled corner leaves NEEDS YOU entirely; only its
 * reviewable change (`open`) keeps gold, because approving an artifact does
 * not need the agent awake.
 */
function needsYouCorner(corner: CornerSummary): boolean {
  if (isCornerStalledOffline(corner)) return false;
  if (corner.awaitingReply) return true;
  return corner.status !== null && cornerSuperState(corner.status) === 'needs-human';
}

/**
 * The one loud word a needs-you Room is allowed to say — the AFFORDANCE the
 * person gets on opening the corner (approve card when a live merge target
 * exists, reply focus otherwise, retry, nudge/close). The STATE word on every
 * surface is just needs-human; this names what to do about it.
 */
const NEEDS_YOU_ACTION: Record<string, string> = {
  open: 'APPROVE',
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
/**
 * A finished Room: archived on the relay, or one whose corner work has all
 * reached a terminal word (`merged`/`archived`). Such a Room holds no live or
 * needs-you state, so the deck hides it behind the collapsed FINISHED entry
 * instead of listing it inline. Two deliberate exclusions: a plain chat Room
 * with no corners is never finished (it has no work to finish), and a `failed`
 * corner never finishes its Room — a failure-stalled card still waits on a
 * person's retry, which is NEEDS YOU state.
 */
export function roomIsFinished(
  room: Pick<RoomRowInput, 'archived' | 'corners'>,
): boolean {
  if (room.archived) return true;
  const corners = room.corners ?? [];
  if (corners.length === 0) return false;
  // Any unfinished corner — live, worded, or merely stalled (`null`) — keeps
  // the Room active.
  if (corners.some((corner) => !isCornerTerminal(corner.status))) return false;
  // ...and a failure still owes the person an answer.
  return !corners.some((corner) => corner.status === 'failed');
}

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
   * excluded outright: finished work is represented NOWHERE in navigation
   * (no count, no expansion, no pinned bar) per the owner's model — its
   * history stays reachable only through the transcript's landed/closed
   * references. A Room whose corners have all finished therefore carries no
   * corner affordance at all.
   */
  corners: CornerSummary[];
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

export type RoomListSection<T extends RoomRowInput> = {
  /** One of the two deck tiers — never `'working'`, which is a row state only. */
  zone: RoomDeckTier;
  title: string;
  data: Array<{ item: T; row: RoomRowPresentation }>;
};

function cornerTimestamp(corner: CornerSummary): number {
  return corner.lastActivityAt ?? corner.createdAt ?? 0;
}

function newestNeedsYou(
  corners: readonly CornerSummary[],
): CornerSummary | undefined {
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
function newestStalledOffline(
  corners: readonly CornerSummary[],
): CornerSummary | undefined {
  return corners
    .filter(isCornerStalledOffline)
    .sort(
      (a, b) =>
        cornerTimestamp(b) - cornerTimestamp(a) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    )[0];
}

/** Newest corner carrying one of the given legacy words. */
function newestByStatus(
  corners: readonly CornerSummary[],
  statuses: ReadonlySet<CornerStatus>,
): CornerSummary | undefined {
  return corners
    .filter(
      (corner): corner is CornerSummary & { status: CornerStatus } =>
        corner.status !== null && statuses.has(corner.status),
    )
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
  // The state line speaks THE three words; finished keeps its landed flavor,
  // archived says nothing. An offline-stalled corner says so plainly instead
  // of the lie "Waiting on you" — nobody is waiting on anyone while the agent
  // is unreachable.
  if (isCornerStalledOffline(corner)) {
    return `Agent offline · ${corner.name}`;
  }
  switch (cornerSuperState(corner.status)) {
    case 'working':
      return `${actorName(corner, authorNames, 'Agent')} working · ${corner.name}`;
    case 'needs-human':
      return `Waiting on you · ${corner.name}`;
    case 'finished':
      return corner.status === 'merged'
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
    ...all
      .filter((corner) => MEANINGFUL_CORNER_SUPERSTATES.has(cornerSuperState(corner.status)))
      .map(cornerTimestamp),
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
  return (
    b.row.meaningfulAt - a.row.meaningfulAt ||
    (a.item.title ?? a.item.id ?? '').localeCompare(b.item.title ?? b.item.id ?? '')
  );
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
 * Build the deck's ACTIVE sections: NEEDS YOU first (rooms with a corner
 * genuinely waiting on the human), then IDLE — every other visible Room,
 * working ones included, newest activity first. Recency headings (TODAY /
 * YESTERDAY / EARLIER) are retired: attention-state and recency were
 * semantically different tiers, so the deck now has exactly two labels, and
 * each row's mark already conveys working vs quiet. Finished Rooms (archived,
 * or all corner work terminal) belong to NO inline section — they surface
 * only through {@link finishedRoomEntries}, which backs the collapsed entry.
 *
 * This is deliberately the only Room ordering function the screen consumes
 * for its tiers: lifecycle state, fact text, age, and placement all come from
 * the same projection. (`options.now` remains accepted for call-site
 * stability; zoning no longer depends on wall-clock buckets.)
 */
export function roomListSections<T extends RoomRowInput>(
  rooms: readonly T[],
  authorNames: ReadonlyMap<string, string>,
  _options: { now?: number } = {},
): RoomListSection<T>[] {
  const activeRooms = rooms.filter((item) => !roomIsFinished(item));
  const projected = projectEntries(activeRooms, authorNames);
  const sections: RoomListSection<T>[] = [];
  for (const tier of ROOM_LIST_TIER_ORDER) {
    const data = projected
      .filter(
        (entry) =>
          entry.row.zone === tier || (tier === 'idle' && entry.row.zone === 'working'),
      )
      .sort(byRecency);
    if (data.length > 0) sections.push({ zone: tier, title: ROOM_LIST_ZONE_LABELS[tier], data });
  }
  return sections;
}

/**
 * The finished Rooms the deck collapses into one bottom entry — archived on
 * the relay, or every corner terminal — newest first. Never listed inline by
 * any tier; the screen renders them only when that entry is expanded.
 */
export function finishedRoomEntries<T extends RoomRowInput>(
  rooms: readonly T[],
  authorNames: ReadonlyMap<string, string>,
): Array<RankedEntry<T>> {
  return projectEntries(
    rooms.filter((item) => roomIsFinished(item)),
    authorNames,
  ).sort(byRecency);
}
