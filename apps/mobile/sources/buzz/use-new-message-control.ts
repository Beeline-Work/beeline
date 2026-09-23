import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatDisplayMessage } from './room-view-presentation';
import {
  EMPTY_NEW_MESSAGE_QUEUE,
  acknowledgeNewMessageQueue,
  catchUpOfferEligible,
  messageContainsBoundary,
  newMessageBadgeCount,
  newestJumpDiscVisible,
  queueIncomingMessages,
  type NewMessageQueue,
} from './room-new-message-boundary';

/**
 * The answers a transcript owes a reader about unread mail, kept apart the
 * way Slack keeps them apart:
 *
 * - the unread glyph marks where the reader's unread run began when they
 *   opened this Room. The opening cursor owns it, and a live arrival may
 *   never move it. Reaching the newest row retires it: the run it marks the
 *   start of has been read, and a landmark that outlives what it marks is the
 *   line readers found still sitting there after catching up;
 * - the jump disc says the newest message is off screen. It is a way back to
 *   newest and nothing else, so it shows on viewport visibility alone,
 *   whether or not anything new is waiting;
 * - the badge on that disc counts the unread run, and reaching the newest row
 *   clears it exactly as a tap on the disc would;
 * - catch-up eligibility, which the disc carries as a long-press door.
 *
 * Divider and count used to be drawn from the live queue alone, which is what
 * put a fresh divider under the newest row and left the old pill sitting over
 * a Room the reader had already caught up on.
 */
export function useNewMessageControl({
  roomId,
  queueableMessages,
  arrivingIds,
  newestMessageId,
  firstUnreadMessageId,
  openingUnreadCounts,
  isPinnedToTail,
  enabled = true,
}: {
  roomId: string;
  /** Rows exactly as the list renders them, so a fold is queued by its host. */
  queueableMessages: readonly ChatDisplayMessage[];
  arrivingIds: ReadonlySet<string>;
  newestMessageId: string | null;
  firstUnreadMessageId: string | null;
  openingUnreadCounts: { messages: number; agentTurns: number } | null;
  /** Tail distance, which decides auto-follow and nothing this control shows. */
  isPinnedToTail: () => boolean;
  /** Room unread state is disabled in corners; only the tail chevron remains. */
  enabled?: boolean;
}): {
  /** The opening unread row for this visit. */
  dividerMessageId: string | null;
  queue: NewMessageQueue;
  /** The jump disc: shown for as long as the newest row is off screen. */
  discVisible: boolean;
  /** What the disc's badge reads, or 0 for no badge. */
  badgeCount: number;
  catchUpVisible: boolean;
  observeVisibleMessages: (visible: readonly ChatDisplayMessage[]) => void;
  settleQueueAtBoundary: (boundaryId: string) => void;
} {
  const [queue, setQueue] = useState<NewMessageQueue>(EMPTY_NEW_MESSAGE_QUEUE);
  // Any visible pixel of the newest row, as the list's own viewability pass
  // reports it. False until that pass has run, which is why the disc waits on
  // `hasObservedVisibility`: it now shows without a queue behind it, so an
  // unanswered viewport would flash one over every Room at open.
  const [newestMessageVisible, setNewestMessageVisible] = useState(false);
  const [hasObservedVisibility, setHasObservedVisibility] = useState(false);
  // The glyph's own end. Set when a viewability pass AFTER the opening one
  // reports the newest row on screen — the reader's own scroll down, or their
  // tap on the disc, which lands there and reports.
  const [boundaryRead, setBoundaryRead] = useState(false);
  // Read inside the observation callback, where the state above is a commit
  // behind: the opening pass must not retire a line drawn in the same frame.
  const hasObservedVisibilityRef = useRef(false);
  const visibleMessagesRef = useRef<readonly ChatDisplayMessage[]>([]);
  const newestMessageIdRef = useRef(newestMessageId);
  newestMessageIdRef.current = newestMessageId;
  const isPinnedToTailRef = useRef(isPinnedToTail);
  isPinnedToTailRef.current = isPinnedToTail;

  useEffect(() => {
    setQueue(EMPTY_NEW_MESSAGE_QUEUE);
    setNewestMessageVisible(false);
    setHasObservedVisibility(false);
    hasObservedVisibilityRef.current = false;
    visibleMessagesRef.current = [];
  }, [roomId, enabled]);

  // A boundary the reader has not been shown yet is not one they have read.
  // The server cursor arrives after the first paint, and `markUnreadFrom`
  // replaces it mid-visit; either way the new line starts its own life.
  useEffect(() => setBoundaryRead(false), [roomId, enabled, firstUnreadMessageId]);

  useLayoutEffect(() => {
    if (!enabled || arrivingIds.size === 0) return;
    setQueue((current) =>
      queueIncomingMessages(current, {
        messages: queueableMessages,
        arrivingIds,
        isPinnedToTail: isPinnedToTailRef.current(),
      }),
    );
  }, [arrivingIds, enabled, queueableMessages]);

  // A row arriving below the fold leaves the viewable set untouched, so the
  // list has no reason to run its viewability pass, and the last report —
  // taken while the row above was still the newest — would stand as if the
  // arrival were on screen. Re-ask the same question against that report
  // whenever the newest row changes: an arrival the reader cannot see answers
  // false and the control appears without waiting for a scroll that may never
  // come.
  useEffect(() => {
    setNewestMessageVisible(
      visibleMessagesRef.current.some((message) =>
        messageContainsBoundary(message, newestMessageIdRef.current),
      ),
    );
  }, [newestMessageId]);

  const observeVisibleMessages = useCallback(
    (visible: readonly ChatDisplayMessage[]) => {
      visibleMessagesRef.current = visible;
      const newestVisible = visible.some((message) =>
        messageContainsBoundary(message, newestMessageIdRef.current),
      );
      setNewestMessageVisible(newestVisible);
      setHasObservedVisibility(true);
      const opening = !hasObservedVisibilityRef.current;
      hasObservedVisibilityRef.current = true;
      // Reaching the newest message is what the control asks for; arriving there
      // under the reader's own finger settles the queue exactly as a tap would,
      // and retires the unread line the same way. The OPENING pass is exempt:
      // a short unread run can leave boundary and newest on screen together at
      // open, and retiring there would blink the line out before the reader
      // could look at it.
      if (enabled && newestVisible) {
        setQueue(acknowledgeNewMessageQueue);
        if (!opening) setBoundaryRead(true);
      }
    },
    [enabled],
  );

  const settleQueueAtBoundary = useCallback(
    (boundaryId: string) => {
      if (!enabled) return;
      setQueue((current) =>
        current.boundaryId === boundaryId ? acknowledgeNewMessageQueue(current) : current,
      );
    },
    [enabled],
  );

  // The glyph marks where the reader's unread run began. Later read-mark
  // updates and live arrivals cannot move it; only reaching newest ends it.
  return {
    dividerMessageId: enabled && !boundaryRead ? firstUnreadMessageId : null,
    queue: enabled ? queue : EMPTY_NEW_MESSAGE_QUEUE,
    discVisible: newestJumpDiscVisible({
      newestMessageId,
      newestMessageVisible,
      hasObservedVisibility,
    }),
    badgeCount: enabled ? newMessageBadgeCount(queue, newestMessageVisible) : 0,
    catchUpVisible:
      enabled && !boundaryRead && catchUpOfferEligible(firstUnreadMessageId, openingUnreadCounts),
    observeVisibleMessages,
    settleQueueAtBoundary,
  };
}
