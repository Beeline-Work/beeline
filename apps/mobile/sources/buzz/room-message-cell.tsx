import React from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { StyleSheet } from 'react-native-unistyles';
import Svg, { Path } from 'react-native-svg';
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
  catchUpOffered = false,
  onOpenCatchUp,
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
  /** Whether the unread run is long enough to be worth a catch-up offer. */
  catchUpOffered?: boolean;
  onOpenCatchUp?: () => void;
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
        // Resolved per row, so only the boundary row's prop ever changes when
        // the offer comes and goes. A bare `catchUpOffered` here would be a
        // new value on every row of the transcript and re-render all of them.
        offersCatchUp={catchUpOffered && messageContainsBoundary(item, firstNewMessageId)}
        onOpenCatchUp={onOpenCatchUp}
      />
    ),
    [
      arrivalFlashMessageId,
      arrivingCardIds,
      catchUpOffered,
      continuedIds,
      firstNewMessageId,
      messageById,
      onOpenCatchUp,
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
  offersCatchUp = false,
  onOpenCatchUp,
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
  offersCatchUp?: boolean;
  onOpenCatchUp?: () => void;
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
          {startsNewMessages && (
            <NewMessagesDivider offersCatchUp={offersCatchUp} onOpenCatchUp={onOpenCatchUp} />
          )}
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

/**
 * A page with two lines on it, the mark for "there is a summary behind this".
 * Drawn at 13 rather than the divider glyph's 12 because its detail is four
 * strokes instead of one, and at 12 the fold closes up.
 */
function CatchUpDocumentGlyph({ color }: { color: string }) {
  return (
    <Svg width={13} height={13} viewBox="0 0 13 13" accessibilityElementsHidden>
      <Path
        d="M3.25 1.5 H7.5 L10 4 V11.5 H3.25 Z"
        fill="none"
        stroke={color}
        strokeWidth={1.2}
        strokeLinejoin="round"
      />
      <Path d="M7.5 1.5 V4 H10" fill="none" stroke={color} strokeWidth={1.2} strokeLinejoin="round" />
      <Path d="M5.2 6.9 H8.2" stroke={color} strokeWidth={1.2} strokeLinecap="round" />
      <Path d="M5.2 9.1 H7.2" stroke={color} strokeWidth={1.2} strokeLinecap="round" />
    </Svg>
  );
}

/**
 * Where the reader's unread run begins, and — when there is enough behind it
 * to be worth summarizing — the door to the catch-up sheet.
 *
 * The offer sits on the line rather than in floating chrome because the line
 * already marks the exact range catch-up would cover. The strip this replaces
 * rode over the top of the transcript in every Room the reader was behind in,
 * which is the one place they are trying to read.
 *
 * Two shapes, because catch-up is thresholded: under six agent turns or
 * fifteen messages there is nothing to offer, so the line is the bare mark it
 * has always been, and pressing it does nothing because nothing is there.
 */
export function NewMessagesDivider({
  offersCatchUp = false,
  onOpenCatchUp,
}: {
  offersCatchUp?: boolean;
  onOpenCatchUp?: () => void;
}) {
  if (offersCatchUp && onOpenCatchUp) {
    return (
      <View style={styles.newMessages} testID="new-messages-divider">
        <View style={styles.newMessagesRule} />
        <Pressable
          accessibilityHint="Opens catch up for everything below this line"
          accessibilityLabel="New messages begin here"
          accessibilityRole="button"
          hitSlop={styles.catchUpHitSlop}
          onPress={onOpenCatchUp}
          style={({ pressed }) => [styles.catchUpPill, pressed && styles.catchUpPillPressed]}
          testID="new-messages-catch-up"
        >
          <Text style={styles.catchUpPillLabel}>NEW</Text>
          <CatchUpDocumentGlyph color={styles.newMessagesGlyph.color} />
        </Pressable>
        <View style={styles.newMessagesRule} />
      </View>
    );
  }
  return (
    <View
      accessibilityLabel="Unread messages begin here"
      accessibilityRole="text"
      style={styles.newMessages}
      testID="new-messages-divider"
    >
      <View style={styles.newMessagesRule} />
      <Svg width={12} height={12} viewBox="0 0 12 12" accessibilityElementsHidden>
        <Path
          d="M6 1.5 10.5 6 6 10.5 1.5 6Z"
          fill="none"
          stroke={styles.newMessagesGlyph.color}
          strokeWidth={1.5}
        />
      </Svg>
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
  newMessagesGlyph: { color: theme.buzz.accent },
  // The pill is 22 tall, which is half a touch target. The hit slop makes up
  // the rest without pushing the transcript's rows apart: an in-flow 44pt row
  // would put a band of empty space across the ledger wherever the offer is
  // live, and the offer is live in exactly the Rooms a reader is trying to
  // read through.
  catchUpHitSlop: { top: 11, bottom: 11, left: 8, right: 8 },
  catchUpPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.buzz.space.xs + 1,
    height: 22,
    paddingHorizontal: theme.buzz.space.sm + 2,
    borderRadius: 11,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.buzz.border,
    backgroundColor: theme.buzz.bgHighlight,
  },
  catchUpPillPressed: { opacity: 0.72 },
  // The caps micro-label role, which is the one the retired NEW MESSAGES
  // label used and already carries its own tracking and transform.
  catchUpPillLabel: {
    ...theme.buzz.type.sectionHead,
    color: theme.buzz.accent,
  },
}));
