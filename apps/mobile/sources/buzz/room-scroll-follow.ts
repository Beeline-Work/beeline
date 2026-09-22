import { useLayoutEffect, useRef } from 'react';

/**
 * The captain's scroll rule for the transcript (2026-09): whenever a new
 * message or live card mutation arrives for the open Room or corner, the
 * viewport follows it to the newest end. A cold open follows the same tail
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
 * Ordinary inverted-list tail. It is the speaker-change margin (24px) minus the
 * newest row's own 6px bottom padding, so the visual gap under the newest
 * message is the same 24px whether or not the turn line paints over it.
 */
const PHONE_TRANSCRIPT_BASE_TAIL_PADDING = 18;

/**
 * The inverted phone transcript's visual-tail padding. Always the ordinary
 * speaker-change margin, and this function's whole job is to be the one place
 * that says so.
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

export type DesktopOpenLandingDecision = 'scroll' | 'settle' | 'hold';

/**
 * A chronological virtualized list may reveal more measured content after
 * each cold-open jump. Keep landing through that growth even though each
 * programmatic jump can temporarily report the viewport as unpinned.
 */
export function desktopOpenLandingOnContentSizeChange({
  active,
  previousHeight,
  nextHeight,
  isUserDragging,
}: {
  active: boolean;
  previousHeight: number | null;
  nextHeight: number;
  isUserDragging: boolean;
}): DesktopOpenLandingDecision {
  if (!active) return 'hold';
  if (isUserDragging) return 'settle';
  if (previousHeight !== null && nextHeight <= previousHeight) return 'settle';
  return 'scroll';
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
  isPinnedToTail: _isPinnedToTail,
  isUserDragging,
  openLandsOnTail = true,
}: {
  /** Newest row id seen before this commit; null on a cold open. */
  previousNewestId: string | null;
  /** Newest row id in this commit; null when the transcript is empty. */
  nextNewestId: string | null;
  /** The pre-arrival position is intentionally observed but does not gate a
   *  new Room message: both tail and history must land on the new row. */
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

export type TailLandingDecision = {
  /** Re-land the viewport on the measured tail with this content change. */
  land: boolean;
  /** The follow is finished — clear the armed landing state. */
  disarm: boolean;
};

/**
 * One measured desktop tail landing (2026-09): the arrival scroll's own
 * metrics are stale the moment a row appends — React Native Web's FlatList
 * estimates unmeasured frames, so `scrollToEnd` lands mid-list and strands
 * the reader above the row they asked to follow (proof/desktop-append-
 * overlap). The landing converges on the measured condition instead of a
 * fixed count: each provisional content height only advances about one
 * render batch, so a longer transcript simply needs more landings — re-land
 * while the tail gap is still above the pin threshold, then disarm after it
 * remains closed across the settle window so a leftover can never move a
 * reader who has since paged into history. The follow also holds a measured
 * offset: growth below the tail never lowers scrollTop, so a drop below the
 * held offset is the reader leaving for history — wheel, scrollbar, PageUp,
 * any modality — and it disarms the follow immediately instead of yanking
 * them back. Fresh wheel or touch activity vetoes and disarms the follow
 * too: React Native Web never fires the drag callbacks on the platform that
 * runs this code. The cap is a backstop against a landing that stops
 * advancing, not the termination condition.
 */
export function desktopTailLanding({
  tailGapAboveThreshold,
  tailStable,
  isUserScrolling,
  readerMovedUp,
  landingsRemaining,
}: {
  tailGapAboveThreshold: boolean;
  tailStable: boolean;
  isUserScrolling: boolean;
  /**
   * The reader's offset dropped below the offset the follow last held them
   * at; only deliberate upward motion can do that, never tail growth.
   */
  readerMovedUp: boolean;
  landingsRemaining: number;
}): TailLandingDecision {
  if (isUserScrolling || readerMovedUp) return { land: false, disarm: true };
  if (landingsRemaining <= 0) return { land: false, disarm: true };
  if (tailGapAboveThreshold) return { land: true, disarm: false };
  return { land: false, disarm: tailStable };
}

/**
 * Did the previous landing leave the follow in the SAME place (extent and
 * scroll position unchanged)? That is the only honest "stalled" fact: a
 * landing that reached the bottom it was shown cannot be charged for the
 * gap RN Web later reopens by measuring rows above the viewport — on a long
 * transcript every landing reaches the bottom and the measured gap still
 * grows, so a gap-based budget would exhaust before a 500-row list ever
 * converges and the cap would become transcript-length-dependent. A follow
 * that produces no movement at all while the gap stays open is the backstop
 * case the cap exists for.
 */
export function tailFollowStalled(
  previous: { scrollHeight: number; scrollTop: number } | null,
  current: { scrollHeight: number; scrollTop: number } | null,
  stallEpsilon: number,
): boolean {
  if (!previous || !current) return false;
  return (
    Math.abs(previous.scrollHeight - current.scrollHeight) <= stallEpsilon &&
    Math.abs(previous.scrollTop - current.scrollTop) <= stallEpsilon
  );
}
