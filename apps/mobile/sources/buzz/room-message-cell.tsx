import React from 'react';
import type { ChatDisplayMessage } from './room-view-presentation';
import { ledgerDayCaption } from './message-dates';
import { withLedgerDayCaption } from '@/components/buzz/Ledger';
import {
  createTranscriptCardMotionStore,
  TranscriptCardMotionBoundary,
  type TranscriptCardMotionStore,
} from '@/components/buzz/transcript-card-motion-context';

export type RoomMessageRenderContext = {
  continued: boolean;
  immediatelyPrecedingMessage?: ChatDisplayMessage;
  referencedMessage?: ChatDisplayMessage;
};

export type RoomMessageRenderer = (
  item: ChatDisplayMessage,
  context: RoomMessageRenderContext,
) => React.ReactNode;

export function useRoomMessageRenderItem({
  render,
  continuedIds,
  precedingMessageById,
  messageById,
  arrivingCardIds = new Set(),
  cardMotionStore,
}: {
  render: RoomMessageRenderer;
  continuedIds: ReadonlySet<string>;
  precedingMessageById: ReadonlyMap<string, ChatDisplayMessage>;
  messageById: ReadonlyMap<string, ChatDisplayMessage>;
  arrivingCardIds?: ReadonlySet<string>;
  cardMotionStore?: TranscriptCardMotionStore;
}) {
  const fallbackMotionStore = React.useRef(createTranscriptCardMotionStore()).current;
  const resolvedCardMotionStore = cardMotionStore ?? fallbackMotionStore;
  return React.useCallback(
    ({ item }: { item: ChatDisplayMessage }) => (
      <RoomMessageCell
        item={item}
        render={render}
        continued={continuedIds.has(item.id)}
        immediatelyPrecedingMessage={precedingMessageById.get(item.id)}
        referencedMessage={item.replyToId ? messageById.get(item.replyToId) : undefined}
        cardArriving={arrivingCardIds.has(item.id)}
        cardMotionStore={resolvedCardMotionStore}
      />
    ),
    [
      arrivingCardIds,
      continuedIds,
      messageById,
      precedingMessageById,
      render,
      resolvedCardMotionStore,
    ],
  );
}

/** Keep an unchanged FlatList row mounted when a live insertion updates its parent list. */
export const RoomMessageCell = React.memo(function RoomMessageCell({
  item,
  render,
  continued,
  immediatelyPrecedingMessage,
  referencedMessage,
  cardArriving = false,
  cardMotionStore,
}: {
  item: ChatDisplayMessage;
  render: RoomMessageRenderer;
  continued: boolean;
  immediatelyPrecedingMessage?: ChatDisplayMessage;
  referencedMessage?: ChatDisplayMessage;
  cardArriving?: boolean;
  cardMotionStore?: TranscriptCardMotionStore;
}) {
  const fallbackMotionStore = React.useRef(createTranscriptCardMotionStore()).current;
  return (
    <TranscriptCardMotionBoundary
      arriving={cardArriving}
      cardId={item.id}
      store={cardMotionStore ?? fallbackMotionStore}
    >
      {withLedgerDayCaption(
        render(item, { continued, immediatelyPrecedingMessage, referencedMessage }),
        ledgerDayCaption(item.timestamp, immediatelyPrecedingMessage?.timestamp),
      )}
    </TranscriptCardMotionBoundary>
  );
});
