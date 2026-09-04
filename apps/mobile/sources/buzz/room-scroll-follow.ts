/**
 * The captain's scroll rule for the transcript (2026-09): whenever a new
 * message or live draft arrives for the open Room or corner, the viewport
 * always goes to the newest end, once per arrival — unless the user's finger
 * is mid-drag, which is never interrupted.
 *
 * C97: a send that collapses the composer (pending attach unmounts, field
 * snaps back to its minimum height, keyboard usually drops) makes the list
 * taller with no new row id, so the arrival rule above never fires for it.
 * `maintainVisibleContentPosition` anchors on the previous row (index 1, by
 * design — see `[channelId].tsx`) and only auto-follows a shrink within
 * `autoscrollToTopThreshold` of the tail, which a keyboard-sized drop
 * exceeds. `scrollFollowOnLayoutChange` covers that gap: it follows the
 * composer/keyboard footprint directly instead of widening that threshold.
 *
 * Pure decisions so the FlatList wiring in `[channelId].tsx` stays effects
 * off the render path and the rules stay independently testable.
 */
export type ScrollFollowDecision = 'scroll' | 'hold';

export function scrollFollowOnArrival({
  previousNewestId,
  nextNewestId,
  isUserDragging,
}: {
  /** Newest row id seen before this commit; null on a cold open. */
  previousNewestId: string | null;
  /** Newest row id in this commit; null when the transcript is empty. */
  nextNewestId: string | null;
  /** A drag (or its momentum) is in progress right now. */
  isUserDragging: boolean;
}): ScrollFollowDecision {
  // Nothing arrived (same newest row, or an emptied transcript).
  if (!nextNewestId || nextNewestId === previousNewestId) return 'hold';
  // Cold open already lands on the tail; no scroll call.
  if (previousNewestId === null) return 'hold';
  // Never fight the user's finger mid-drag.
  if (isUserDragging) return 'hold';
  return 'scroll';
}

export function scrollFollowOnLayoutChange({
  previousFootprint,
  nextFootprint,
  isPinnedToTail,
  isUserDragging,
}: {
  /** Composer height + keyboard height before this commit; null before the first measurement. */
  previousFootprint: number | null;
  /** Composer height + keyboard height in this commit. */
  nextFootprint: number;
  /** The reader was already at (or within the tail threshold of) the newest end. */
  isPinnedToTail: boolean;
  /** A drag (or its momentum) is in progress right now. */
  isUserDragging: boolean;
}): ScrollFollowDecision {
  // First measurement; nothing to compare against yet.
  if (previousFootprint === null) return 'hold';
  // Only a shrink (composer collapsing, keyboard dismissing) opens a gap.
  if (nextFootprint >= previousFootprint) return 'hold';
  // A reader who scrolled back to read history keeps their place.
  if (!isPinnedToTail) return 'hold';
  // Never fight the user's finger mid-drag.
  if (isUserDragging) return 'hold';
  return 'scroll';
}
