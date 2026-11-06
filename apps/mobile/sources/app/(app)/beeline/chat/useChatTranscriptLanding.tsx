import React, { useEffect, useLayoutEffect, useCallback } from 'react';
import { Platform } from 'react-native';
import { type ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { roomOpenLandsOnTail, useScrollFollowOnArrival } from '@/buzz/room-scroll-follow';
import { requestMessageJump } from '@/buzz/transcript-scroll-controller';
import { hostRowIndex } from '@/buzz/room-message-store';
import { TAIL_PIN_THRESHOLD } from './chat-surface-values';

type Props = [
  scrollController: import("@/buzz/transcript-scroll-controller").TranscriptScrollController<ChatDisplayMessage>,
  observeTailPinned: (pinned: boolean) => void,
  desktopTranscript: boolean,
  restoreDesktopReadingAnchor: () => void,
  transcriptMessages: ChatDisplayMessage[],
  transcriptJump: import("@/buzz/room-message-store").RoomJump | null,
  isCorner: boolean,
  firstUnreadMessageId: string | null,
  messageAnchorId: string,
  decodedId: string,
  loadLatestTranscriptMessages: () => void,
  liveDraftStore: import("@/buzz/live-draft-drain").LiveDraftDrainStore,
  voice: import("@/buzz/use-voice-call").VoiceCallState,
  foldedMessages: ChatDisplayMessage[],
  notificationResponseId: string | undefined,
  notificationMessageId: string | undefined,
  notificationTarget: string | undefined,
  handledNotificationAnchorRef: React.RefObject<string | null>,
  transcriptHostIdsRef: React.RefObject<ReadonlyMap<string, string>>,
  messageJumpCanScrollTo: (messageId: string, index: number) => boolean,
  roomClient: import("@/sync/transport/room-view-client").RoomViewClient | null,
  cacheViewerPubkey: string,
  roomSurface: import("@beeline/api-contract/phone").RoomView | null,
  jumpToTranscriptMessage: (messageId: string) => void,
  anchoredSegmentActive: boolean,
  transcriptNewerStatus: import("@/buzz/room-message-store").TranscriptHistoryStatus,
  desktopScrollNodeRef: React.RefObject<HTMLElement | null>,
  loadNewerTranscriptMessages: () => void,
];

export function useChatTranscriptLanding([
  scrollController, observeTailPinned, desktopTranscript, restoreDesktopReadingAnchor,
  transcriptMessages, transcriptJump, isCorner, firstUnreadMessageId, messageAnchorId, decodedId,
  loadLatestTranscriptMessages, liveDraftStore, voice, foldedMessages, notificationResponseId,
  notificationMessageId, notificationTarget, handledNotificationAnchorRef, transcriptHostIdsRef,
  messageJumpCanScrollTo, roomClient, cacheViewerPubkey, roomSurface, jumpToTranscriptMessage,
  anchoredSegmentActive, transcriptNewerStatus, desktopScrollNodeRef, loadNewerTranscriptMessages,
]: Props): [
  landAtOwnSend: (messageId: string) => void,
  observePhoneTailOffset: (offsetY: number) => void,
  landAtNewestMessage: () => void,
] {

  // Pinned? Native offset 0 is the visual bottom of the inverted list. iOS
  // drops `onScroll` ticks inside the throttle window and never sends the
  // resting offset as one; only momentum-end (or drag-end with no momentum)
  // carries it. With a 100 ms window, a scroll that settled on the newest row
  // left both this reading and the list's viewability report short of the
  // tail, so the jump chevron and its badge stayed up over the newest row.
  const observePhoneTailOffset = useCallback(
    (offsetY: number) => {
      const pinned = offsetY <= TAIL_PIN_THRESHOLD;
      scrollController.observeTailPinned(pinned);
      observeTailPinned(pinned);
    },
    [observeTailPinned, scrollController],
  );

  // Older history paging and rolling live windows can both change rows above
  // the reader. Restore a visible row's screen offset, with browser anchoring
  // disabled so this is the only correction. Tail and explicit landings retain
  // their own authority.
  useLayoutEffect(() => {
    if (!desktopTranscript) return;
    restoreDesktopReadingAnchor();
  }, [restoreDesktopReadingAnchor, desktopTranscript, transcriptMessages]);

  // Desktop rows are in the DOM once they commit, so each commit is a layout
  // pass for the active request: a landing scrolls again, and a send that
  // waits for its own row lands once that row exists, before paint. The phone
  // list reports its own passes (content size and viewability).
  useLayoutEffect(() => {
    if (!desktopTranscript) return;
    scrollController.observeLayout();
  }, [desktopTranscript, scrollController, transcriptJump, transcriptMessages]);

  // A Room opened with unread messages lands on the first of them.
  useEffect(() => {
    if (isCorner || !firstUnreadMessageId || messageAnchorId) return;
    scrollController.request({ kind: 'firstUnread', messageId: firstUnreadMessageId });
  }, [decodedId, firstUnreadMessageId, isCorner, messageAnchorId, scrollController]);

  // The disc's one job. It lands on the tail itself rather than on a queued
  // boundary row, so a reader who is merely re-reading history — no queue at
  // all — gets back to the live end in one tap, and a reader with unread mail
  // arrives where the next message will land. The request replaces any
  // landing in progress.
  const landAtNewestMessage = useCallback(() => {
    loadLatestTranscriptMessages();
    scrollController.request({ kind: 'newest' });
    // The badge is NOT cleared here. A press is not visibility: this scroll
    // can be clamped, interrupted by a drag, or land short while the extent
    // is still measuring, and clearing on the press alone would tell the
    // reader they had seen rows they never reached. The viewability pass
    // clears it when the newest row is actually on screen — the same rule
    // that clears it when they scroll there under their own finger.
  }, [loadLatestTranscriptMessages, scrollController]);

  // The viewer sending is the viewer saying they are speaking at the live end
  // of the log, so the transcript lands there and shows them their own
  // message. The request replaces any landing in progress and pins the tail,
  // which the arrival rule reads to decide whether the appended row follows.
  // On desktop the scroll can run before a burst's final row commits, so the
  // request waits for this exact row and lands once more when it exists.
  const landAtOwnSend = useCallback(
    (messageId: string) => {
      loadLatestTranscriptMessages();
      scrollController.request(
        desktopTranscript ? { kind: 'newest', untilRowId: messageId } : { kind: 'newest' },
      );
    },
    [desktopTranscript, loadLatestTranscriptMessages, scrollController],
  );

  useEffect(
    () =>
      liveDraftStore.subscribeCommit(() => {
        if (!scrollController.isPinnedToTail()) return;
        if (Platform.OS === 'android') scrollController.followAfterLayout();
        else scrollController.follow();
      }),
    [liveDraftStore, scrollController],
  );

  // A call starts at the live end, rather than retaining an automatic unread
  // landing. Deliberate history navigation keeps the existing arrival badge.
  const joinedCallId = voice.call?.id ?? null;

  useEffect(() => {
    if (joinedCallId && scrollController.enterCall()) loadLatestTranscriptMessages();
  }, [joinedCallId, loadLatestTranscriptMessages, scrollController]);

  // Only a different tail row is an arrival. Lifecycle updates repaint the
  // existing row and must not pull a reader out of history.
  const newestMessageId = foldedMessages.at(-1)?.id ?? null;

  const arrivalFollow = useScrollFollowOnArrival({
    newestId: newestMessageId,
    isPinnedToTail: scrollController.isPinnedToTail(),
    isUserDragging: scrollController.isUserDragging(),
    openLandsOnTail: roomOpenLandsOnTail({ desktopTranscript, messageAnchorId }),
  });

  useLayoutEffect(() => {
    if (arrivalFollow === 'hold') return;
    // Desktop's own ResizeObserver (`setDesktopContentNode` above) already
    // re-lands on the real DOM as the appended row's layout commits; this
    // call is a harmless, idempotent second landing for the same content —
    // native has no such observer and depends on it entirely. A landing in
    // progress keeps the list; `follow` yields to it.
    if (Platform.OS === 'android') scrollController.followAfterLayout();
    else scrollController.follow();
  }, [newestMessageId, scrollController]);

  // Land on the exact fact that caused the alert, at the top of the screen.
  // A host row near the newest end lands at once. Otherwise the store opens
  // a window that keeps the target near its newest end: from resident rows at
  // once, or from a read around the id. The room stays usable throughout, and
  // the target is highlighted when its row is drawn.
  useEffect(() => {
    if (!notificationResponseId) return;
    const anchorKey = `${notificationResponseId}:${notificationMessageId ?? notificationTarget ?? ''}`;
    if (handledNotificationAnchorRef.current === anchorKey) return;

    const messageId = notificationMessageId?.trim();
    if (!messageId) return;
    const hostIndex = hostRowIndex(transcriptMessages, transcriptHostIdsRef.current, messageId);
    const needsRead =
      transcriptJump?.messageId !== messageId &&
      !(hostIndex >= 0 && messageJumpCanScrollTo(messageId, hostIndex));
    // The store finds a target in the Room's rows without a read, and joins a
    // read's page to them. A read answered before the Room's first rows opens
    // a window that cannot join them, and the target settles mid-screen.
    if (needsRead && (!roomClient || !cacheViewerPubkey || roomSurface?.room.id !== decodedId))
      return;
    handledNotificationAnchorRef.current = anchorKey;
    requestMessageJump(scrollController, messageId, needsRead ? jumpToTranscriptMessage : null);
  }, [
    cacheViewerPubkey,
    decodedId,
    jumpToTranscriptMessage,
    notificationMessageId,
    notificationResponseId,
    notificationTarget,
    roomClient,
    roomSurface,
    scrollController,
    transcriptJump,
    transcriptMessages,
  ]);

  useEffect(() => {
    if (
      !desktopTranscript ||
      !anchoredSegmentActive ||
      scrollController.isLanding() ||
      transcriptNewerStatus !== 'idle'
    )
      return;
    const node = desktopScrollNodeRef.current;
    if (node && node.scrollHeight <= node.clientHeight + TAIL_PIN_THRESHOLD) {
      loadNewerTranscriptMessages();
    }
  }, [
    desktopTranscript,
    anchoredSegmentActive,
    transcriptNewerStatus,
    transcriptMessages,
    loadNewerTranscriptMessages,
  ]);
  return [
    landAtOwnSend, observePhoneTailOffset, landAtNewestMessage,
  ];
}
