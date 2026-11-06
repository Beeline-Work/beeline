import { observeArtifactRows } from '@/buzz/artifact-viewport';
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { type ViewToken } from 'react-native';
import { useFocusEffect, router } from 'expo-router';
import { type ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { shouldFollowDesktopTail } from '@/buzz/room-scroll-follow';
import { messageJumpHref } from '@/buzz/corner-navigation';
import { arrivalFlashTiming } from '@/buzz/room-arrival-flash';
import { useArtifactReturn } from '@/buzz/use-artifact-return';
import { messageBoundaryIds } from '@/buzz/room-new-message-boundary';
import { pinnedTailReadReport } from '@/buzz/read-cursor-advance';
import { PHONE_FIRST_RENDER_ROWS, TAIL_PIN_THRESHOLD } from './chat-surface-values';

type Props = [
  desktopScrollNodeRef: React.RefObject<HTMLElement | null>,
  scrollController: import("@/buzz/transcript-scroll-controller").TranscriptScrollController<ChatDisplayMessage>,
  messageAnchorId: string,
  decodedId: string,
  desktopTranscript: boolean,
  transcriptJump: import("@/buzz/room-message-store").RoomJump | null,
  transcriptPositions: { getSnapshot: () => import("@/buzz/use-transcript-scrubber").TranscriptScrubberSnapshot; subscribe(listener: () => void): () => void; reveal: () => void; observeScroll(event: { contentOffset: { y: number; }; contentSize: { height: number; }; layoutMeasurement: { height: number; }; }): void; observeContentSize(contentHeight: number): void; observeVisibleRows(rows: readonly ChatDisplayMessage[]): void; reset(): void; dispose(): void; },
  observeVisibleMessages: (visible: readonly ChatDisplayMessage[]) => void,
  advanceReadCursor: (chronological: readonly ChatDisplayMessage[], visible: readonly ChatDisplayMessage[]) => void,
  chronologicalMessagesRef: React.RefObject<ChatDisplayMessage[]>,
  anchoredSegmentActive: boolean,
  isFocused: () => boolean,
  newMessageHasObservedVisibility: boolean,
  newestTranscriptMessageId: string | null,
  visibleMessages: ChatDisplayMessage[],
  transcriptMessagesRef: React.RefObject<ChatDisplayMessage[]>,
  transcriptMessages: ChatDisplayMessage[],
  combinedMessages: ChatDisplayMessage[],
  revealTranscriptThrough: (count: number) => void,
  desktopContentObserverRef: React.RefObject<ResizeObserver | null>,
  desktopContentNodeRef: React.RefObject<HTMLElement | null>,
  observeTailPinned: (pinned: boolean) => void,
  loadNewerTranscriptMessages: () => void,
  loadOlderTranscriptMessages: () => void,
];

export function useChatDesktopScroll([
  desktopScrollNodeRef, scrollController, messageAnchorId, decodedId, desktopTranscript,
  transcriptJump, transcriptPositions, observeVisibleMessages, advanceReadCursor,
  chronologicalMessagesRef, anchoredSegmentActive, isFocused, newMessageHasObservedVisibility,
  newestTranscriptMessageId, visibleMessages, transcriptMessagesRef, transcriptMessages,
  combinedMessages, revealTranscriptThrough, desktopContentObserverRef, desktopContentNodeRef,
  observeTailPinned, loadNewerTranscriptMessages, loadOlderTranscriptMessages,
]: Props): [
  desktopRowNodesRef: React.RefObject<Map<string, HTMLElement>>,
  messageJumpCanScrollTo: (messageId: string, index: number) => boolean,
  raiseSourceLandingFlash: (messageId: string) => void,
  messageAnchorIdRef: React.RefObject<string>,
  raiseArrivalFlash: (messageId: string) => void,
  restoreDesktopReadingAnchor: () => void,
  handleOpenCode: (messageId: string) => void,
  handleOpenMessageSource: (roomId: string, messageId: string) => void,
  arrivalFlashMessageId: string | null,
  sourceLandingFlashMessageId: string | null,
  setDesktopScrollNode: (node: HTMLElement | null) => void,
  handleDesktopScroll: (event: { currentTarget: HTMLElement; }) => void,
  setDesktopContentNode: (node: HTMLElement | null) => void,
  getDesktopRowRefCallback: (id: string) => (node: HTMLElement | null) => void,
  observeVisibleTranscriptMessages: ({ viewableItems }: { viewableItems: ViewToken<ChatDisplayMessage>[]; }) => void,
] {

  // Row DOM nodes by message id, for id-based jumps (notification anchor,
  // unread boundary, artifact origin) and viewability — no index math, no
  // scrollToIndex failure/retry.
  const desktopRowNodesRef = useRef<Map<string, HTMLElement>>(new Map());

  const desktopVisibilityObserverRef = useRef<IntersectionObserver | null>(null);

  const desktopIntersectingIdsRef = useRef<Set<string>>(new Set());

  const desktopReadingAnchorRef = useRef<{ id: string; offset: number } | null>(null);

  const captureDesktopReadingAnchor = useCallback(() => {
    const node = desktopScrollNodeRef.current;
    desktopReadingAnchorRef.current = null;
    if (!node || scrollController.isPinnedToTail() || scrollController.isLanding()) return;
    const viewport = node.getBoundingClientRect();
    let firstTop = Infinity;
    for (const [id, row] of desktopRowNodesRef.current) {
      const bounds = row.getBoundingClientRect();
      if (bounds.bottom > viewport.top && bounds.top < viewport.bottom && bounds.top < firstTop) {
        firstTop = bounds.top;
        desktopReadingAnchorRef.current = { id, offset: bounds.top - viewport.top };
      }
    }
  }, [scrollController]);

  const restoreDesktopReadingAnchor = useCallback(() => {
    const node = desktopScrollNodeRef.current;
    const anchor = desktopReadingAnchorRef.current;
    const row = anchor ? desktopRowNodesRef.current.get(anchor.id) : undefined;
    if (node && row && anchor) {
      scrollController.holdReadingPosition(
        row.getBoundingClientRect().top - node.getBoundingClientRect().top - anchor.offset,
      );
    }
    captureDesktopReadingAnchor();
  }, [captureDesktopReadingAnchor, scrollController]);

  // The row a completed notification landing is pointing at, for as long as
  // the pointer plays. Cleared on its own timer, so the next landing on the
  // same row is a fresh false→true edge and a re-render is not.
  const [arrivalFlashMessageId, setArrivalFlashMessageId] = useState<string | null>(null);

  const arrivalFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The row a settled message-source jump (a quote reference, a forward
  // source, a notification target) just centered. Same one-cycle timing as
  // the arrival pointer above, but its own brass tint — this is a reader
  // reaching for a specific message, not the passive "you arrived here" mark.
  const [sourceLandingFlashMessageId, setSourceLandingFlashMessageId] = useState<string | null>(
    null,
  );

  const sourceLandingFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const messageAnchorIdRef = useRef(messageAnchorId);

  messageAnchorIdRef.current = messageAnchorId;

  const sourceJumpSequenceRef = useRef(0);

  const handleOpenMessageSource = useCallback((roomId: string, messageId: string) => {
    sourceJumpSequenceRef.current += 1;
    router.navigate(
      messageJumpHref(roomId, messageId, `message-source:${sourceJumpSequenceRef.current}`),
    );
  }, []);

  const raiseArrivalFlash = useCallback((messageId: string) => {
    if (arrivalFlashTimerRef.current !== null) clearTimeout(arrivalFlashTimerRef.current);
    setArrivalFlashMessageId(messageId);
    arrivalFlashTimerRef.current = setTimeout(() => {
      arrivalFlashTimerRef.current = null;
      setArrivalFlashMessageId(null);
      // The cell reads the system setting itself; this timer only has to
      // outlast the longer of the two shapes it can take.
    }, arrivalFlashTiming(false).totalMs);
  }, []);

  const raiseSourceLandingFlash = useCallback((messageId: string) => {
    if (sourceLandingFlashTimerRef.current !== null)
      clearTimeout(sourceLandingFlashTimerRef.current);
    setSourceLandingFlashMessageId(messageId);
    sourceLandingFlashTimerRef.current = setTimeout(() => {
      sourceLandingFlashTimerRef.current = null;
      setSourceLandingFlashMessageId(null);
    }, arrivalFlashTiming(false).totalMs);
  }, []);

  useEffect(
    () => () => {
      if (arrivalFlashTimerRef.current !== null) clearTimeout(arrivalFlashTimerRef.current);
      if (sourceLandingFlashTimerRef.current !== null)
        clearTimeout(sourceLandingFlashTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    scrollController.reset();
    desktopRowNodesRef.current.clear();
    desktopRowRefCallbacksRef.current.clear();
    desktopIntersectingIdsRef.current.clear();
    desktopReadingAnchorRef.current = null;
  }, [decodedId, scrollController]);

  // A message jump reaches its row by one scroll once the row is near the
  // newest end of the phone list, which draws only its first rows at once. A
  // row further up lands through a store window that keeps it near that end.
  // A row that is already shown lands now, even while a read for it is still
  // out; the landing ends that read.
  const messageJumpCanScrollTo = (messageId: string, index: number) =>
    desktopTranscript ||
    index < PHONE_FIRST_RENDER_ROWS ||
    (transcriptJump?.messageId === messageId &&
      (transcriptJump.status === 'ready' || transcriptJump.status === 'loading'));

  const observeVisibleTranscriptMessages = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken<ChatDisplayMessage>[] }) => {
      const visibleRows = viewableItems
        .filter((token) => token.isViewable)
        .map((token) => token.item);
      observeArtifactRows(decodedId, visibleRows.flatMap(messageBoundaryIds));
      transcriptPositions.observeVisibleRows(visibleRows);
      // The list recomputes viewability on scroll AND on every committed
      // update, so an arrival that lands below the fold reports itself unseen
      // without the reader touching anything.
      observeVisibleMessages(visibleRows);
      // The same report is what moves the read mark. A row that never entered
      // the viewport is never read, however far below it the transcript runs.
      // Chronological order, never `transcriptMessagesRef` — that one is
      // reversed on the phone, and the cursor ranks by index.
      advanceReadCursor(chronologicalMessagesRef.current, visibleRows);
      // A landing is done when this report shows its row; until then each
      // report scrolls to it again.
      scrollController.observeVisibleRows(visibleRows);
    },
    [decodedId, advanceReadCursor, observeVisibleMessages, scrollController, transcriptPositions],
  );

  // The viewport pass above owns the read boundary, but it does not run when
  // an arrival only changes which row is NEWEST while the list already rests
  // at the tail — the same stale report `useNewMessageControl` re-asks for.
  // Re-ask the read cursor there: a DM opened at, or held at, its tail must
  // move the server mark too, or the Room list's unread dot outlives the read.
  // `pinnedTailReadReport` refuses without the list's own evidence: a cold
  // open's pin starts true and a first-unread landing is still to come, so a
  // fetched tail must never be read over messages sitting below the fold. A
  // reader in history, a landing in progress, or a provisional draft/live lane
  // all write nothing.
  useFocusEffect(useCallback(() => {
    if (anchoredSegmentActive || !isFocused()) return;
    const chronological = chronologicalMessagesRef.current;
    const report = pinnedTailReadReport(chronological, {
      pinnedToTail: scrollController.isPinnedToTail(),
      landing: scrollController.isLanding(),
      hasObservedVisibility: newMessageHasObservedVisibility,
    });
    if (!report.length) return;
    advanceReadCursor(chronological, report);
  }, [
    advanceReadCursor,
    anchoredSegmentActive,
    isFocused,
    newMessageHasObservedVisibility,
    newestTranscriptMessageId,
    // An anchored card can arrive without changing the tail row's id.
    visibleMessages,
    scrollController,
  ]));

  // Back from the code reader: center the row the reader opened it from.
  const scrollToArtifactOrigin = useCallback(
    (index: number) => {
      const messageId = transcriptMessagesRef.current[index]?.id;
      if (!messageId) return;
      scrollController.request({ kind: 'message', messageId, align: 'center', jump: false });
    },
    [scrollController],
  );

  const handleOpenCode = useArtifactReturn({
    transcriptMessages,
    residentMessages: combinedMessages,
    onReveal: revealTranscriptThrough,
    onScroll: scrollToArtifactOrigin,
  });

  // Re-land on every REAL layout change of the desktop content — an
  // appended row, streaming text growing the newest row, a late-loading
  // image — while the reader is already pinned to the tail. One measured
  // comparison, no retry budget: `scrollTop`/`scrollHeight` are native
  // browser state, so a reader who scrolled away is simply no longer
  // pinned; there is nothing left to disarm.
  //
  // Pin state itself is read from the scroll controller, not recomputed here:
  // a cold open has no scroll event yet (scrollTop is still 0 against the
  // full, taller-than-viewport content), so a fresh scrollTop/scrollHeight
  // read at that instant says "not pinned" and would never take the first
  // landing. The controller's pin starts true and is corrected only by a real
  // scroll, which is the same invariant the native list already relies on.
  const setDesktopContentNode = useCallback(
    (node: HTMLElement | null) => {
      desktopContentObserverRef.current?.disconnect();
      desktopContentObserverRef.current = null;
      desktopContentNodeRef.current = node;
      if (!node || typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(() => {
        if (!desktopScrollNodeRef.current) return;
        if (
          shouldFollowDesktopTail({
            isPinnedToTail: scrollController.isPinnedToTail(),
            isUserDragging: scrollController.isUserDragging(),
            hasLandingAnchor: scrollController.isLanding(),
          })
        ) {
          scrollController.followNow();
        } else {
          restoreDesktopReadingAnchor();
        }
      });
      observer.observe(node);
      desktopContentObserverRef.current = observer;
    },
    [restoreDesktopReadingAnchor, scrollController],
  );

  const setDesktopScrollNode = useCallback(
    (node: HTMLElement | null) => {
      desktopScrollNodeRef.current = node;
      desktopVisibilityObserverRef.current?.disconnect();
      desktopVisibilityObserverRef.current = null;
      if (!node || typeof IntersectionObserver === 'undefined') return;
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const id = (entry.target as HTMLElement).dataset?.rowId;
            if (!id) continue;
            if (entry.isIntersecting) desktopIntersectingIdsRef.current.add(id);
            else desktopIntersectingIdsRef.current.delete(id);
          }
          observeVisibleTranscriptMessages({
            viewableItems: transcriptMessagesRef.current
              .filter((item) => desktopIntersectingIdsRef.current.has(item.id))
              .map((item) => ({ item, isViewable: true }) as ViewToken<ChatDisplayMessage>),
          });
        },
        { root: node, threshold: 0 },
      );
      desktopVisibilityObserverRef.current = observer;
      for (const rowNode of desktopRowNodesRef.current.values()) observer.observe(rowNode);
    },
    [observeVisibleTranscriptMessages],
  );

  const registerDesktopRowNode = useCallback((id: string, node: HTMLElement | null) => {
    const previous = desktopRowNodesRef.current.get(id);
    if (previous && previous !== node) desktopVisibilityObserverRef.current?.unobserve(previous);
    if (node) {
      desktopRowNodesRef.current.set(id, node);
      desktopVisibilityObserverRef.current?.observe(node);
    } else {
      desktopRowNodesRef.current.delete(id);
      desktopIntersectingIdsRef.current.delete(id);
    }
  }, []);

  // A stable ref callback per row id, so a re-render that leaves a row's id
  // unchanged does not toggle its DOM node out of and back into the
  // observers above (a fresh inline `ref` closure does that on every commit).
  const desktopRowRefCallbacksRef = useRef<Map<string, (node: HTMLElement | null) => void>>(
    new Map(),
  );

  const getDesktopRowRefCallback = useCallback(
    (id: string) => {
      let callback = desktopRowRefCallbacksRef.current.get(id);
      if (!callback) {
        callback = (node) => registerDesktopRowNode(id, node);
        desktopRowRefCallbacksRef.current.set(id, callback);
      }
      return callback;
    },
    [registerDesktopRowNode],
  );

  useEffect(
    () => () => {
      desktopContentObserverRef.current?.disconnect();
      desktopVisibilityObserverRef.current?.disconnect();
    },
    [],
  );

  // Pinned? Real scrollHeight/scrollTop/clientHeight, not RN Web's
  // contentOffset/contentSize estimates — the same formula the follow above
  // reads off the live scroll node.
  const handleDesktopScroll = useCallback(
    (event: { currentTarget: HTMLElement }) => {
      const node = event.currentTarget;
      const pinned = node.scrollHeight - node.scrollTop - node.clientHeight <= TAIL_PIN_THRESHOLD;
      scrollController.observeTailPinned(pinned);
      observeTailPinned(pinned);
      captureDesktopReadingAnchor();
      if (anchoredSegmentActive && pinned && !scrollController.isLanding())
        loadNewerTranscriptMessages();
      if (
        (!pinned || node.scrollHeight <= node.clientHeight + TAIL_PIN_THRESHOLD) &&
        node.scrollTop <= TAIL_PIN_THRESHOLD
      ) {
        loadOlderTranscriptMessages();
      }
    },
    [
      anchoredSegmentActive,
      captureDesktopReadingAnchor,
      loadNewerTranscriptMessages,
      loadOlderTranscriptMessages,
      observeTailPinned,
      scrollController,
    ],
  );
  return [
    desktopRowNodesRef, messageJumpCanScrollTo, raiseSourceLandingFlash, messageAnchorIdRef,
    raiseArrivalFlash, restoreDesktopReadingAnchor, handleOpenCode, handleOpenMessageSource,
    arrivalFlashMessageId, sourceLandingFlashMessageId, setDesktopScrollNode, handleDesktopScroll,
    setDesktopContentNode, getDesktopRowRefCallback, observeVisibleTranscriptMessages,
  ];
}
