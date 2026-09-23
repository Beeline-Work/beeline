import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatDisplayMessage } from './room-view-presentation';
import {
  EMPTY_NEW_MESSAGE_QUEUE,
  acknowledgeNewMessageQueue,
  catchUpStripVisible,
  messageContainsBoundary,
  newMessageBadgeCount,
  newestJumpDiscVisible,
  queueIncomingMessages,
  type NewMessageQueue,
} from './room-new-message-boundary';
// The strip's line and the sheet's blocks are one module's words, so the two
// doors into catch-up cannot phrase the same range differently.
import { catchUpStripLabel } from './room-catch-up-report';

/**
 * The answers a transcript owes a reader about unread mail, kept apart the
 * way Slack keeps them apart:
 *
 * - the unread glyph marks where the reader's unread run began when they
 *   opened this Room. The opening cursor owns it for the visit, and a live
 *   arrival may never move it;
 * - the jump disc says the newest message is off screen. It is a way back to
 *   newest and nothing else, so it shows on viewport visibility alone,
 *   whether or not anything new is waiting;
 * - the badge on that disc counts the unread run, and reaching the newest row
 *   clears it exactly as a tap on the disc would;
 * - the catch-up strip says what that run is — how many and from whom — and
 *   lands at its first message rather than at newest.
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
  catchUpSummary: string;
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
  const visibleMessagesRef = useRef<readonly ChatDisplayMessage[]>([]);
  const newestMessageIdRef = useRef(newestMessageId);
  newestMessageIdRef.current = newestMessageId;
  const isPinnedToTailRef = useRef(isPinnedToTail);
  isPinnedToTailRef.current = isPinnedToTail;

  useEffect(() => {
    setQueue(EMPTY_NEW_MESSAGE_QUEUE);
    setNewestMessageVisible(false);
    setHasObservedVisibility(false);
    visibleMessagesRef.current = [];
  }, [roomId, enabled]);

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
      // Reaching the newest message is what the control asks for; arriving there
      // under the reader's own finger settles the queue exactly as a tap would,
      // while the opening boundary stays anchored for this visit.
      if (enabled && newestVisible) {
        setQueue(acknowledgeNewMessageQueue);
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

  // The glyph marks the opening boundary for this visit. Later read-mark
  // updates and live arrivals cannot move or retire it.
  const unreadSinceAt =
    queueableMessages.find((message) => messageContainsBoundary(message, firstUnreadMessageId))
      ?.timestamp ?? null;
  return {
    dividerMessageId: enabled ? firstUnreadMessageId : null,
    queue: enabled ? queue : EMPTY_NEW_MESSAGE_QUEUE,
    discVisible: newestJumpDiscVisible({
      newestMessageId,
      newestMessageVisible,
      hasObservedVisibility,
    }),
    badgeCount: enabled ? newMessageBadgeCount(queue, newestMessageVisible) : 0,
    catchUpVisible: enabled && catchUpStripVisible(firstUnreadMessageId, openingUnreadCounts),
    // The control labels the boundary, leaving count display to the server
    // cursor rather than this visit's partial live queue.
    catchUpSummary: catchUpStripLabel({ since: unreadSinceAt }),
    observeVisibleMessages,
    settleQueueAtBoundary,
  };
}
