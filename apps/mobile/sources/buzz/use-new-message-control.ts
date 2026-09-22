import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatDisplayMessage } from './room-view-presentation';
import {
  EMPTY_NEW_MESSAGE_QUEUE,
  acknowledgeNewMessageQueue,
  messageContainsBoundary,
  newMessageControlVisible,
  queueIncomingMessages,
  type NewMessageQueue,
} from './room-new-message-boundary';

/**
 * The two answers a transcript owes a reader about unread mail, kept apart the
 * way Slack keeps them apart:
 *
 * - the NEW MESSAGES divider says where the reader's unread run began when
 *   they opened this Room. The server's opening cursor owns it for the whole
 *   visit and a live arrival may never move it;
 * - the jump control says a newer message exists that the reader cannot see.
 *   Actual viewport visibility decides it, and reaching the newest row settles
 *   it exactly as a tap on it would.
 *
 * Both used to be drawn from the live queue alone, which is what put a fresh
 * divider under the newest row and left the control sitting over a Room the
 * reader had already caught up on.
 */
export function useNewMessageControl({
  roomId,
  queueableMessages,
  arrivingIds,
  newestMessageId,
  firstUnreadMessageId,
  isPinnedToTail,
}: {
  roomId: string;
  /** Rows exactly as the list renders them, so a fold is queued by its host. */
  queueableMessages: readonly ChatDisplayMessage[];
  arrivingIds: ReadonlySet<string>;
  newestMessageId: string | null;
  firstUnreadMessageId: string | null;
  /** Tail distance, which decides auto-follow and nothing this control shows. */
  isPinnedToTail: () => boolean;
}): {
  /** The one row allowed to paint the divider, or null when the visit opened read. */
  dividerMessageId: string | null;
  queue: NewMessageQueue;
  controlVisible: boolean;
  observeVisibleMessages: (visible: readonly ChatDisplayMessage[]) => void;
  settleQueueAtBoundary: (boundaryId: string) => void;
} {
  const [queue, setQueue] = useState<NewMessageQueue>(EMPTY_NEW_MESSAGE_QUEUE);
  // Any visible pixel of the newest row, as the list's own viewability pass
  // reports it. False until that pass has run, which costs nothing: an empty
  // queue draws no control either way.
  const [newestMessageVisible, setNewestMessageVisible] = useState(false);
  const visibleMessagesRef = useRef<readonly ChatDisplayMessage[]>([]);
  const newestMessageIdRef = useRef(newestMessageId);
  newestMessageIdRef.current = newestMessageId;
  const isPinnedToTailRef = useRef(isPinnedToTail);
  isPinnedToTailRef.current = isPinnedToTail;

  useEffect(() => {
    setQueue(EMPTY_NEW_MESSAGE_QUEUE);
    setNewestMessageVisible(false);
    visibleMessagesRef.current = [];
  }, [roomId]);

  useLayoutEffect(() => {
    if (arrivingIds.size === 0) return;
    setQueue((current) =>
      queueIncomingMessages(current, {
        messages: queueableMessages,
        arrivingIds,
        isPinnedToTail: isPinnedToTailRef.current(),
      }),
    );
  }, [arrivingIds, queueableMessages]);

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

  const observeVisibleMessages = useCallback((visible: readonly ChatDisplayMessage[]) => {
    visibleMessagesRef.current = visible;
    const newestVisible = visible.some((message) =>
      messageContainsBoundary(message, newestMessageIdRef.current),
    );
    setNewestMessageVisible(newestVisible);
    // Reaching the newest message is what the control asks for; arriving there
    // under the reader's own finger settles the queue exactly as a tap would.
    // Without this the count survived every scroll back to the tail.
    if (newestVisible) setQueue(acknowledgeNewMessageQueue);
  }, []);

  const settleQueueAtBoundary = useCallback((boundaryId: string) => {
    setQueue((current) =>
      current.boundaryId === boundaryId ? acknowledgeNewMessageQueue(current) : current,
    );
  }, []);

  return {
    // The divider is the server's cursor and only ever the server's cursor.
    dividerMessageId: firstUnreadMessageId,
    queue,
    controlVisible: newMessageControlVisible(queue, newestMessageVisible),
    observeVisibleMessages,
    settleQueueAtBoundary,
  };
}
