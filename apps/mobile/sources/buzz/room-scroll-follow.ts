import { useLayoutEffect, useRef } from 'react';

/**
 * The captain's scroll rule for the transcript (2026-09): whenever a new
 * message or live card mutation arrives for the open Room or corner, the
 * viewport follows only if the reader was already at the newest end. Reading
 * history is never interrupted. A cold open follows the same tail landing the
 * platform's list already gives: `openLandsOnTail` is true where an inverted
 * list puts the newest row in view by itself, and a chronological list (the
 * desktop transcript) asks for one scroll call instead.
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
  isPinnedToTail,
  isUserDragging,
  openLandsOnTail = true,
}: {
  /** Newest row id seen before this commit; null on a cold open. */
  previousNewestId: string | null;
  /** Newest row id in this commit; null when the transcript is empty. */
  nextNewestId: string | null;
  /** The reader was already at (or within the threshold of) the newest end. */
  isPinnedToTail: boolean;
  /** A drag (or its momentum) is in progress right now. */
  isUserDragging: boolean;
  /** Opening puts the newest row in view by itself (a native inverted list
   *  starts at its bottom). A chronological desktop list starts at its top,
   *  so its open must land on the tail through a scroll call. */
  openLandsOnTail?: boolean;
}): ScrollFollowDecision {
  // Nothing arrived (same newest row, or an emptied transcript).
  if (!nextNewestId || nextNewestId === previousNewestId) return 'hold';
  // Cold open: an inverted list already shows the newest end at offset 0; a
  // chronological list shows its oldest row there and must scroll to the
  // tail to match the same landing.
  if (previousNewestId === null) return openLandsOnTail ? 'hold' : 'scroll';
  if (!isPinnedToTail) return 'hold';
  // Never fight the user's finger mid-drag.
  if (isUserDragging) return 'hold';
  return 'scroll';
}

/**
 * Decide during render, before React Native Web lays out the appended row and
 * can report the formerly pinned viewport as being above the new bottom.
 */
export function useScrollFollowOnArrival({
  newestId,
  isPinnedToTail,
  isUserDragging,
  openLandsOnTail = true,
}: {
  newestId: string | null;
  isPinnedToTail: boolean;
  isUserDragging: boolean;
  /** See `scrollFollowOnArrival`. */
  openLandsOnTail?: boolean;
}): ScrollFollowDecision {
  const previousNewestIdRef = useRef<string | null>(null);
  const decision = scrollFollowOnArrival({
    previousNewestId: previousNewestIdRef.current,
    nextNewestId: newestId,
    isPinnedToTail,
    isUserDragging,
    openLandsOnTail,
  });
  useLayoutEffect(() => {
    previousNewestIdRef.current = newestId;
  }, [newestId]);
  return decision;
}

export function scrollFollowOnLayoutChange({
  previousFootprint,
  nextFootprint,
  previousLayoutKey,
  nextLayoutKey,
  isPinnedToTail,
  isUserDragging,
}: {
  /** Composer height + keyboard height before this commit; null before the first measurement. */
  previousFootprint: number | null;
  /** Composer height + keyboard height in this commit. */
  nextFootprint: number;
  /** Fixed chrome rendered below the list before this commit. */
  previousLayoutKey?: string | null;
  /** Fixed chrome rendered below the list in this commit. */
  nextLayoutKey?: string;
  /** The reader was already at (or within the tail threshold of) the newest end. */
  isPinnedToTail: boolean;
  /** A drag (or its momentum) is in progress right now. */
  isUserDragging: boolean;
}): ScrollFollowDecision {
  // First measurement; nothing to compare against yet.
  if (previousFootprint === null) return 'hold';
  const fixedChromeChanged =
    previousLayoutKey != null && nextLayoutKey != null && previousLayoutKey !== nextLayoutKey;
  // A composer/keyboard shrink makes the viewport taller. Mounting or
  // unmounting either fixed status line changes the viewport in the other
  // direction, but maintainVisibleContentPosition can retain an offset in
  // both cases. Growth from opening the keyboard alone remains native-owned.
  if (nextFootprint >= previousFootprint && !fixedChromeChanged) return 'hold';
  // A reader who scrolled back to read history keeps their place.
  if (!isPinnedToTail) return 'hold';
  // Never fight the user's finger mid-drag.
  if (isUserDragging) return 'hold';
  return 'scroll';
}

/**
 * Capture the tail verdict during render, before the native list lays out the
 * new footer height and reports the resulting offset. Reading the pinned ref
 * from an effect is too late: `maintainVisibleContentPosition` has already
 * moved it away from zero by then, so the old composer-sized gap is retained.
 */
export function useScrollFollowOnLayoutChange({
  footprint,
  layoutKey,
  isPinnedToTail,
  isUserDragging,
}: {
  footprint: number;
  layoutKey?: string;
  isPinnedToTail: boolean;
  isUserDragging: boolean;
}): ScrollFollowDecision {
  const previousFootprintRef = useRef<number | null>(null);
  const previousLayoutKeyRef = useRef<string | null>(null);
  const decision = scrollFollowOnLayoutChange({
    previousFootprint: previousFootprintRef.current,
    nextFootprint: footprint,
    previousLayoutKey: previousLayoutKeyRef.current,
    nextLayoutKey: layoutKey,
    isPinnedToTail,
    isUserDragging,
  });
  useLayoutEffect(() => {
    previousFootprintRef.current = footprint;
    previousLayoutKeyRef.current = layoutKey ?? null;
  }, [footprint, layoutKey]);
  return decision;
}
