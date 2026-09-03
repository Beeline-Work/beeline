/**
 * The captain's scroll rule for the transcript (2026-09): whenever a new
 * message or live draft arrives for the open Room or corner, the viewport
 * always goes to the newest end, once per arrival — unless the user's finger
 * is mid-drag, which is never interrupted.
 *
 * Pure decision so the FlatList wiring in `[channelId].tsx` stays one
 * effect and the rule stays independently testable.
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
