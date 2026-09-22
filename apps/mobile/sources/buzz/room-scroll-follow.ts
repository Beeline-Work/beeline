import { useLayoutEffect, useRef } from 'react';
import { COMPOSER_TOP_GAP } from './room-bottom-chrome';

/**
 * The captain's scroll rule for the transcript (2026-09): whenever a new
 * message or live card mutation arrives for the open Room or corner, the
 * viewport follows only while the reader is already at the newest end.
 * Reading history is never interrupted. A cold open follows the same tail
 * landing the platform's list already gives: `openLandsOnTail` is true where
 * an inverted list puts the newest row in view by itself, and a chronological
 * list (the desktop transcript) asks for one scroll call instead.
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

/**
 * Ordinary inverted-list tail. It is the speaker-change margin (24px), plus
 * the fixed 12px composer-top gap, minus the newest row's own 6px bottom
 * padding. The visual gap under the newest message is therefore the same 36px
 * whether or not the turn line paints over it.
 */
const PHONE_TRANSCRIPT_BASE_TAIL_PADDING = 18 + COMPOSER_TOP_GAP;

/**
 * The inverted phone transcript's visual-tail padding. Always the ordinary
 * speaker-change margin plus the fixed composer-top gap, and this function's
 * whole job is to be the one place that says so.
 *
 * It must never be keyed on whether a turn line is showing. Growing the tail
 * while an agent works and shrinking it afterwards is a step the reader sees
 * as the transcript jumping, and it is the first thing anyone tries. The turn
 * line needs nothing from here: it is absolute, painted over the margin the
 * transcript already leaves below its newest message (`room-bottom-chrome`),
 * so it takes no height from the list and this padding has no part to play.
 *
 * That is why the chrome flags are still taken and still ignored. The
 * signature exists to fail the regression: `room-scroll-follow.test.ts` reads
 * the parameters back to prove no caller has started keying padding on them.
 */
export function phoneTranscriptTailPadding(_chrome: {
  turnChromeVisible: boolean;
  pushedChromeVisible: boolean;
}): number {
  return PHONE_TRANSCRIPT_BASE_TAIL_PADDING;
}

/** Phone inverted lists already show the newest row; a chronological desktop
 *  list must scroll to it. A message-id open (bookmark, notification) must
 *  not take that landing — the transcript has to keep that id in view. */
export function roomOpenLandsOnTail({
  desktopTranscript,
  messageAnchorId,
}: {
  desktopTranscript: boolean;
  messageAnchorId?: string | null;
}): boolean {
  return !desktopTranscript && !messageAnchorId?.trim();
}

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

/**
 * Desktop tail-follow (2026-09, superseding eight prior scroll-timing
 * heuristics — see proof/desktop-append-overlap/NOTES.md): React Native
 * Web's `scrollToEnd`/`scrollToOffset`/`onContentSizeChange` report RN's own
 * provisional layout accounting, which can race the browser's real commit
 * and land the reader mid-list. The desktop transcript no longer asks RN Web
 * for any of that — it renders as a plain scrollable View over real DOM, and
 * the tail follow is one measured comparison: land only while the reader's
 * real scroll position is already within the pin threshold of the real
 * scrollHeight. No retry budget, no settle window, no held-offset guard —
 * a `ResizeObserver` on the content node re-checks this on every real layout
 * change (an appended row, streaming text, a late-loading image), and
 * `scrollTop` is native browser state, so a reader who scrolled away is
 * simply no longer pinned; there is nothing left to disarm.
 */
export function shouldFollowDesktopTail({
  isPinnedToTail,
  isUserDragging,
  hasLandingAnchor,
}: {
  isPinnedToTail: boolean;
  isUserDragging: boolean;
  /** A message anchor (notification, unread boundary) owns this landing. */
  hasLandingAnchor: boolean;
}): boolean {
  return isPinnedToTail && !isUserDragging && !hasLandingAnchor;
}
