import React, { useState, useRef } from 'react';
import { View, FlatList, type ViewProps } from 'react-native';
import { type ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { RoomSendPreview } from '@/buzz/room-send-list';
import { desktopTranscriptList, phoneTranscriptList, useTranscriptScrollController } from '@/buzz/transcript-scroll-controller';
import { landingFlashesArrival } from '@/buzz/room-arrival-flash';
import { hostRowIndex } from '@/buzz/room-message-store';
import { boundaryRowIndex } from '@/buzz/room-new-message-boundary';

type Props = [
  sendPreview: RoomSendPreview,
  readDesktopScrollNodeRef: () => React.RefObject<HTMLElement | null>,
  readDesktopRowNodesRef: () => React.RefObject<Map<string, HTMLElement>>,
  readDesktopTranscript: () => boolean,
  readTranscriptMessagesRef: () => React.RefObject<ChatDisplayMessage[]>,
  readTranscriptHostIdsRef: () => React.RefObject<ReadonlyMap<string, string>>,
  readMessageJumpCanScrollTo: () => (messageId: string, index: number) => boolean,
  readFoldedMessages: () => ChatDisplayMessage[],
  readRevealTranscriptThrough: () => (count: number) => void,
  readTranscriptHistoryStatus: () => import("@/buzz/room-message-store").TranscriptHistoryStatus,
  readLoadOlderTranscriptMessages: () => () => void,
  readTranscriptJump: () => import("@/buzz/room-message-store").RoomJump | null,
  readEndTranscriptJump: () => () => void,
  readHeldLandingFromOldestRef: () => React.RefObject<number>,
  readPhoneContentHeightRef: () => React.RefObject<number>,
  readPhoneScrollOffsetRef: () => React.RefObject<number>,
  readHeldLandingShortRef: () => React.RefObject<boolean>,
  readPhoneListHeightRef: () => React.RefObject<number>,
  readRaiseSourceLandingFlash: () => (messageId: string) => void,
  readMessageAnchorIdRef: () => React.RefObject<string>,
  readRaiseArrivalFlash: () => (messageId: string) => void,
  readAnchoredSegmentActive: () => boolean,
];

export function useChatScrollState([
  sendPreview, readDesktopScrollNodeRef, readDesktopRowNodesRef, readDesktopTranscript,
  readTranscriptMessagesRef, readTranscriptHostIdsRef, readMessageJumpCanScrollTo,
  readFoldedMessages, readRevealTranscriptThrough, readTranscriptHistoryStatus,
  readLoadOlderTranscriptMessages, readTranscriptJump, readEndTranscriptJump,
  readHeldLandingFromOldestRef, readPhoneContentHeightRef, readPhoneScrollOffsetRef,
  readHeldLandingShortRef, readPhoneListHeightRef, readRaiseSourceLandingFlash,
  readMessageAnchorIdRef, readRaiseArrivalFlash, readAnchoredSegmentActive,
]: Props): [
  transcriptWindowIdRef: React.RefObject<number>,
  scrollController: import("@/buzz/transcript-scroll-controller").TranscriptScrollController<ChatDisplayMessage>,
  handledNotificationAnchorRef: React.RefObject<string | null>,
  flatListRef: React.RefObject<FlatList<ChatDisplayMessage> | null>,
  phoneRowKey: (rowId: string) => string,
  PhoneTranscriptCell: (props: ViewProps & { cellKey: string; index: number; item: ChatDisplayMessage }) => React.JSX.Element,
  phoneScrollList: import("@/buzz/transcript-scroll-controller").TranscriptScrollList & { scrollToIndexFailed(info: { averageItemLength: number; }): void; },
] {

  const flatListRef = useRef<FlatList<ChatDisplayMessage>>(null);
  // The phone list's row keys, and the keys of the rows it has laid out. Each
  // window's rows get their own keys (`transcriptWindowId`, set below): the
  // list caches a row's position by key, and a row kept from the rows a new
  // window replaced would keep its old position.
  const transcriptWindowIdRef = useRef(0);
  const sendPreviewRef = useRef(sendPreview);
  sendPreviewRef.current = sendPreview;
  const phoneRowKey = (rowId: string) => `${transcriptWindowIdRef.current}:${sendPreviewRef.current.key(rowId)}`;
  const [measuredPhoneRowKeys] = useState(() => new Set<string>());
  const [phoneScrollList] = useState(() =>
    phoneTranscriptList(
      () => flatListRef.current,
      (rowId) => measuredPhoneRowKeys.has(phoneRowKey(rowId)),
    ),
  );
  const [desktopScrollList] = useState(() =>
    desktopTranscriptList(
      () => readDesktopScrollNodeRef().current,
      (rowId) => readDesktopRowNodesRef().current.get(rowId),
    ),
  );
  // The only code that moves the transcript list
  // (`buzz/transcript-scroll-controller.ts`). Features below ask it for a
  // destination: the newest end, a message, or the first unread row. It also
  // holds the tail pin and the drag state. Declared before the
  // transcript-arrival projection so arrivals decide against the pre-append
  // view; its callbacks read the latest render.
  const scrollController = useTranscriptScrollController<ChatDisplayMessage>({
    list: () => (readDesktopTranscript() ? desktopScrollList : phoneScrollList),
    rows: () => readTranscriptMessagesRef().current,
    rowIndex: (destination, rows) =>
      destination.kind === 'firstUnread'
        ? boundaryRowIndex(rows, destination.messageId)
        : hostRowIndex(rows, readTranscriptHostIdsRef().current, destination.messageId),
    canScrollTo: (destination, index) =>
      destination.kind !== 'message' ||
      !destination.jump ||
      readMessageJumpCanScrollTo()(destination.messageId, index),
    onUnreachable: (destination) => {
      if (destination.kind === 'firstUnread') {
        const residentIndex = boundaryRowIndex(readFoldedMessages(), destination.messageId);
        if (residentIndex >= 0) {
          readRevealTranscriptThrough()(readFoldedMessages().length - residentIndex);
        } else if (readTranscriptHistoryStatus() === 'idle') {
          readLoadOlderTranscriptMessages()();
        }
        return;
      }
      // Loading: the row lands when it arrives. Error: the retry line shows.
      // Missing: the room stays at its newest rows under a short note.
      if (
        destination.jump &&
        readTranscriptJump()?.messageId === destination.messageId &&
        readTranscriptJump()!.status === 'missing'
      ) {
        scrollController.cancel();
      }
    },
    onScrolled: (destination) => {
      if (destination.kind !== 'message' || !destination.jump) return;
      readEndTranscriptJump()();
    },
    onLanded: (destination, rowId) => {
      if (scrollController.isHoldingLanding()) {
        readHeldLandingFromOldestRef().current =
          readPhoneContentHeightRef().current - readPhoneScrollOffsetRef().current;
        readHeldLandingShortRef().current = readPhoneContentHeightRef().current < readPhoneListHeightRef().current;
      }
      // The landing is COMPLETE here — the row is on screen, which is the same
      // rule the badge runs on. A flash fired at row mount or at the first
      // scroll would burn off behind the fold while the list was still
      // measuring, and the reader who followed the notification would arrive
      // to nothing.
      if (destination.kind === 'message' && destination.jump) readRaiseSourceLandingFlash()(rowId);
      if (
        destination.kind === 'firstUnread' &&
        landingFlashesArrival({
          landedBoundaryId: destination.messageId,
          messageAnchorId: readMessageAnchorIdRef().current,
        })
      ) {
        readRaiseArrivalFlash()(destination.messageId);
      }
    },
    // A detached window grows newer rows below a landed jump target (the
    // short-list fill, a later page). The target stays where it landed until
    // the reader moves the list.
    holdsLanding: (destination) =>
      destination.kind === 'message' && destination.jump && readAnchoredSegmentActive(),
    // A jump the reader left (a drag, the newest disc, a send, another jump)
    // drops its own read so it cannot move them later. Only its own: a read
    // for another message belongs to the request that replaced this one.
    onCancelled: (destination) => {
      if (
        destination.kind === 'message' &&
        destination.jump &&
        readTranscriptJump()?.messageId === destination.messageId
      )
        readEndTranscriptJump()();
    },
  });
  // The phone list's cell. The list learns a row's position from the cell's
  // layout. That can come after a landing's last scroll and visibility report,
  // with the row off screen, so the landing runs again on it.
  const [PhoneTranscriptCell] = useState(
    () =>
      function PhoneTranscriptCell({
        cellKey,
        index: _index,
        item: _item,
        onLayout,
        ...props
      }: ViewProps & { cellKey: string; index: number; item: ChatDisplayMessage }) {
        return (
          <View
            {...props}
            onLayout={(event) => {
              onLayout?.(event);
              measuredPhoneRowKeys.add(cellKey);
              if (scrollController.isLanding()) scrollController.observeLayout();
            }}
          />
        );
      },
  );
  const handledNotificationAnchorRef = useRef<string | null>(null);
  return [
    transcriptWindowIdRef, scrollController, handledNotificationAnchorRef, flatListRef, phoneRowKey,
    PhoneTranscriptCell, phoneScrollList,
  ];
}
