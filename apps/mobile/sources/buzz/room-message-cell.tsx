import React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ChatDisplayMessage } from './room-view-presentation';

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
  firstUnreadMessageId,
}: {
  render: RoomMessageRenderer;
  firstUnreadMessageId?: string | null;
  continuedIds: ReadonlySet<string>;
  precedingMessageById: ReadonlyMap<string, ChatDisplayMessage>;
  messageById: ReadonlyMap<string, ChatDisplayMessage>;
}) {
  return React.useCallback(
    ({ item }: { item: ChatDisplayMessage }) => (
      <RoomMessageCell
        item={item}
        render={render}
        startsUnread={item.id === firstUnreadMessageId}
        continued={item.id !== firstUnreadMessageId && continuedIds.has(item.id)}
        immediatelyPrecedingMessage={precedingMessageById.get(item.id)}
        referencedMessage={item.replyToId ? messageById.get(item.replyToId) : undefined}
      />
    ),
    [continuedIds, messageById, precedingMessageById, render, firstUnreadMessageId],
  );
}

/** Keep an unchanged FlatList row mounted when a live insertion updates its parent list. */
export const RoomMessageCell = React.memo(function RoomMessageCell({
  item,
  render,
  continued,
  immediatelyPrecedingMessage,
  referencedMessage,
  startsUnread,
}: {
  item: ChatDisplayMessage;
  render: RoomMessageRenderer;
  continued: boolean;
  startsUnread?: boolean;
  immediatelyPrecedingMessage?: ChatDisplayMessage;
  referencedMessage?: ChatDisplayMessage;
}) {
  return (
    <>
      {startsUnread && (
        <View style={styles.unread} testID="new-messages-divider">
          <Text style={styles.caption}>NEW MESSAGES</Text>
        </View>
      )}
      {render(item, { continued, immediatelyPrecedingMessage, referencedMessage })}
    </>
  );
});

const styles = StyleSheet.create((theme) => ({
  unread: { marginTop: theme.buzz.space.md, marginBottom: theme.buzz.space.md },
  caption: {
    ...theme.buzz.type.sectionHead,
    fontFamily: theme.buzz.type.machine.fontFamily,
    color: theme.buzz.ledgerQuiet,
  },
}));
