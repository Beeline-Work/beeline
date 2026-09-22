import React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ChatDisplayMessage } from './room-view-presentation';
import { messageContainsBoundary } from './room-new-message-boundary';
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
  firstNewMessageId,
}: {
  render: RoomMessageRenderer;
  continuedIds: ReadonlySet<string>;
  precedingMessageById: ReadonlyMap<string, ChatDisplayMessage>;
  messageById: ReadonlyMap<string, ChatDisplayMessage>;
  arrivingCardIds?: ReadonlySet<string>;
  cardMotionStore?: TranscriptCardMotionStore;
  firstNewMessageId?: string | null;
}) {
  const fallbackMotionStore = React.useRef(createTranscriptCardMotionStore()).current;
  const resolvedCardMotionStore = cardMotionStore ?? fallbackMotionStore;
  return React.useCallback(
    ({ item }: { item: ChatDisplayMessage }) => (
      <RoomMessageCell
        item={item}
        render={render}
        startsNewMessages={messageContainsBoundary(item, firstNewMessageId)}
        continued={!messageContainsBoundary(item, firstNewMessageId) && continuedIds.has(item.id)}
        immediatelyPrecedingMessage={precedingMessageById.get(item.id)}
        referencedMessage={item.replyToId ? messageById.get(item.replyToId) : undefined}
        cardArriving={arrivingCardIds.has(item.id)}
        cardMotionStore={resolvedCardMotionStore}
      />
    ),
    [
      arrivingCardIds,
      continuedIds,
      firstNewMessageId,
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
  startsNewMessages = false,
  cardArriving = false,
  cardMotionStore,
}: {
  item: ChatDisplayMessage;
  render: RoomMessageRenderer;
  continued: boolean;
  immediatelyPrecedingMessage?: ChatDisplayMessage;
  referencedMessage?: ChatDisplayMessage;
  startsNewMessages?: boolean;
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
        <>
          {startsNewMessages && <NewMessagesDivider />}
          {render(item, { continued, immediatelyPrecedingMessage, referencedMessage })}
        </>,
        ledgerDayCaption(item.timestamp, immediatelyPrecedingMessage?.timestamp),
      )}
    </TranscriptCardMotionBoundary>
  );
});

export function NewMessagesDivider() {
  return (
    <View accessibilityRole="text" style={styles.newMessages} testID="new-messages-divider">
      <View style={styles.newMessagesRule} />
      <Text style={styles.newMessagesLabel}>NEW MESSAGES</Text>
      <View style={styles.newMessagesRule} />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  newMessages: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.buzz.space.sm,
    marginTop: theme.buzz.space.md,
    marginBottom: theme.buzz.space.md,
  },
  newMessagesRule: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.buzz.border,
  },
  newMessagesLabel: {
    ...theme.buzz.type.sectionHead,
    color: theme.buzz.ledgerQuiet,
  },
}));
