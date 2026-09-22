import React from 'react';
import { Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { StyleSheet } from 'react-native-unistyles';
import type { ChatDisplayMessage } from './room-view-presentation';
import { messageContainsBoundary } from './room-new-message-boundary';
import { arrivalFlashTiming } from './room-arrival-flash';
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
  arrivalFlashMessageId = null,
}: {
  render: RoomMessageRenderer;
  continuedIds: ReadonlySet<string>;
  precedingMessageById: ReadonlyMap<string, ChatDisplayMessage>;
  messageById: ReadonlyMap<string, ChatDisplayMessage>;
  arrivingCardIds?: ReadonlySet<string>;
  cardMotionStore?: TranscriptCardMotionStore;
  firstNewMessageId?: string | null;
  /** The row a completed notification landing just put on screen, or null. */
  arrivalFlashMessageId?: string | null;
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
        arrivalFlashing={messageContainsBoundary(item, arrivalFlashMessageId)}
      />
    ),
    [
      arrivalFlashMessageId,
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
  arrivalFlashing = false,
}: {
  item: ChatDisplayMessage;
  render: RoomMessageRenderer;
  continued: boolean;
  immediatelyPrecedingMessage?: ChatDisplayMessage;
  referencedMessage?: ChatDisplayMessage;
  startsNewMessages?: boolean;
  cardArriving?: boolean;
  cardMotionStore?: TranscriptCardMotionStore;
  arrivalFlashing?: boolean;
}) {
  const fallbackMotionStore = React.useRef(createTranscriptCardMotionStore()).current;
  return (
    <TranscriptCardMotionBoundary
      arriving={cardArriving}
      cardId={item.id}
      store={cardMotionStore ?? fallbackMotionStore}
    >
      {withLedgerDayCaption(
        <ArrivalFlashGround flashing={arrivalFlashing}>
          {startsNewMessages && <NewMessagesDivider />}
          {render(item, { continued, immediatelyPrecedingMessage, referencedMessage })}
        </ArrivalFlashGround>,
        ledgerDayCaption(item.timestamp, immediatelyPrecedingMessage?.timestamp),
      )}
    </TranscriptCardMotionBoundary>
  );
});

/**
 * The row's ground. At most one row in a transcript is ever flashing, so the
 * fill — and every animation hook that drives it — is mounted only for that
 * row. The slot stays in the tree as `null` the rest of the time, which keeps
 * the children at a stable position: swapping the wrapper itself in and out
 * would remount the message under it every time a pointer started or ended.
 */
function ArrivalFlashGround({
  children,
  flashing,
}: {
  children: React.ReactNode;
  flashing: boolean;
}) {
  return (
    <View>
      {flashing ? <ArrivalFlashFill /> : null}
      {children}
    </View>
  );
}

/**
 * The arrival pointer: `bgHighlight` laid UNDER the row, never around it, so
 * nothing about the row itself moves or re-lays-out when it plays. One cycle
 * — hold, then fade — and the fill is gone; under reduce-motion the hold is
 * the whole of it and the fill clears without animating.
 *
 * Mounting IS the trigger, and this only mounts for a landing, so a
 * re-render, a refresh or a live arrival replays nothing.
 */
function ArrivalFlashFill() {
  const fill = useSharedValue(0);
  // Read once: the cycle is decided when it starts, so a setting toggled
  // mid-flash cannot restart the pointer the reader is already watching.
  const reduceMotionAtMount = React.useRef(useReducedMotion());

  React.useEffect(() => {
    const { holdMs, fadeMs } = arrivalFlashTiming(reduceMotionAtMount.current);
    fill.value = 1;
    fill.value = withDelay(holdMs, withTiming(0, { duration: fadeMs }));
  }, [fill]);

  const groundStyle = useAnimatedStyle(() => ({ opacity: fill.value }));
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={[styles.arrivalFlashGround, groundStyle]}
      testID="arrival-flash-ground"
    />
  );
}

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
  // Area, not stroke: the fill is the signal, and it sits behind the row's
  // own content so the transcript's layout is untouched while it plays.
  arrivalFlashGround: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.buzz.bgHighlight,
  },
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
