import {
  cornerStatusPresentation,
  roomCornerSignal,
  roomListCorners,
  type CornerSummary,
} from '@/buzz/corners';
import { isMachinePreview, previewAuthorLabel } from '@/buzz/room-list-summary';

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
  /** The one human-readable activity line, sanitized where it was stored. */
  preview: string;
  /** Uppercase mono attribution, `''` when the author is off the roster. */
  author: string;
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
  corners?: readonly CornerSummary[];
  latestMessage?: string;
  latestMessageAuthor?: string;
};

export function roomRowPresentation(
  room: RoomRowInput,
  authorNames: ReadonlyMap<string, string>,
): RoomRowPresentation {
  const all = room.corners ?? [];
  const corners = roomListCorners(all);
  const signal = roomCornerSignal(all);
  // The stored preview was sanitized when it was written; this is the floor
  // for one written by an older build and still sitting in the local cache.
  const stored = room.latestMessage?.trim();
  const preview = stored && !isMachinePreview(stored) ? stored : undefined;
  return {
    glyph: signal ? cornerStatusPresentation(signal).glyph : preview ? '›' : '·',
    live: signal === 'live',
    attention: signal === 'needs-attention',
    corners,
    preview: preview ?? NO_ACTIVITY_PREVIEW,
    author: previewAuthorLabel(
      room.latestMessageAuthor ? authorNames.get(room.latestMessageAuthor) : undefined,
    ),
  };
}
