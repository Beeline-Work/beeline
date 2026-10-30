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

export type RoomMessagePresentation = {
  firstBylineOfDay?: boolean;
  untaggedHint?: boolean;
  deliveryFailed?: boolean;
  speakerWorking?: boolean;
  cornerProposalAnswer?: { decision: 'open' | 'cancel' | null; handle: string } | null;
  cornerProposalAction?: 'open' | 'cancel' | null;
};

export type RoomMessageRenderContext = RoomMessagePresentation & {
  continued: boolean;
  immediatelyPrecedingMessage?: ChatDisplayMessage;
  referencedMessage?: ChatDisplayMessage;
};

export type RoomMessageRenderer = (
  item: ChatDisplayMessage,
  context: RoomMessageRenderContext,
) => React.ReactNode;

const NO_ARRIVING_CARDS: ReadonlySet<string> = new Set();

export function useRoomMessageRenderItem({
  render,
  continuedIds,
  precedingMessageById,
  messageById,
  arrivingCardIds = NO_ARRIVING_CARDS,
  cardMotionStore,
  firstNewMessageId,
  arrivalFlashMessageId = null,
  sourceLandingFlashMessageId = null,
  presentationForMessage,
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
  /** The row a settled quote/forward/notification message-source jump just centered, or null. */
  sourceLandingFlashMessageId?: string | null;
  presentationForMessage?: (item: ChatDisplayMessage) => RoomMessagePresentation;
}) {
  const [fallbackMotionStore] = React.useState(createTranscriptCardMotionStore);
  const resolvedCardMotionStore = cardMotionStore ?? fallbackMotionStore;
  // The row body closes over Room handlers. A fresh payload recreates that
  // function even when a cached row's text did not change. Keep the latest
  // function in a ref so the cell's memo can skip unchanged rows.
  const renderRef = React.useRef(render);
  renderRef.current = render;
  const stableRender = React.useCallback<RoomMessageRenderer>(
    (item, context) => renderRef.current(item, context),
    [],
  );
  return React.useCallback(
    ({ item }: { item: ChatDisplayMessage }) => (
      <TranscriptCardMotionBoundary
        arriving={arrivingCardIds.has(item.id)}
        cardId={item.id}
        store={resolvedCardMotionStore}
      >
        <RoomMessageCell
          {...presentationForMessage?.(item)}
          item={item}
          render={stableRender}
          startsNewMessages={messageContainsBoundary(item, firstNewMessageId)}
          continued={!messageContainsBoundary(item, firstNewMessageId) && continuedIds.has(item.id)}
          immediatelyPrecedingMessage={precedingMessageById.get(item.id)}
          referencedMessage={item.replyToId ? messageById.get(item.replyToId) : undefined}
          arrivalFlashing={messageContainsBoundary(item, arrivalFlashMessageId)}
          sourceLandingFlashing={messageContainsBoundary(item, sourceLandingFlashMessageId)}

        />
      </TranscriptCardMotionBoundary>
    ),
    [
      arrivalFlashMessageId,
      arrivingCardIds,
      continuedIds,
      firstNewMessageId,
      messageById,
      precedingMessageById,
      presentationForMessage,
      resolvedCardMotionStore,
      stableRender,
      sourceLandingFlashMessageId,
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
  arrivalFlashing = false,
  sourceLandingFlashing = false,
  firstBylineOfDay,
  untaggedHint,
  deliveryFailed,
  speakerWorking,
  cornerProposalAnswer,
  cornerProposalAction,
}: RoomMessagePresentation & {
  item: ChatDisplayMessage;
  render: RoomMessageRenderer;
  continued: boolean;
  immediatelyPrecedingMessage?: ChatDisplayMessage;
  referencedMessage?: ChatDisplayMessage;
  startsNewMessages?: boolean;
  arrivalFlashing?: boolean;
  sourceLandingFlashing?: boolean;
}) {
  return withLedgerDayCaption(
    <ArrivalFlashGround
      flashing={arrivalFlashing || sourceLandingFlashing}
      tint={sourceLandingFlashing ? 'brass' : 'pointer'}
    >
      {startsNewMessages && <NewMessagesDivider />}
      {render(item, {
        continued, immediatelyPrecedingMessage, referencedMessage,
        firstBylineOfDay, untaggedHint, deliveryFailed, speakerWorking,
        cornerProposalAnswer, cornerProposalAction,
      })}
    </ArrivalFlashGround>,
    ledgerDayCaption(item.timestamp, immediatelyPrecedingMessage?.timestamp),
  );
});

/** The ground's two shapes: the passive arrival pointer, and a reader reaching for one exact message. */
type FlashTint = 'pointer' | 'brass';

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
  tint = 'pointer',
}: {
  children: React.ReactNode;
  flashing: boolean;
  tint?: FlashTint;
}) {
  return (
    <View>
      {flashing ? <ArrivalFlashFill tint={tint} /> : null}
      {children}
    </View>
  );
}

/**
 * The arrival pointer: `bgHighlight` (or, for a reader-initiated jump to one
 * exact message, `brassWash` — the same token the ledger already uses for a
 * settling card, never a new color) laid UNDER the row, never around it, so
 * nothing about the row itself moves or re-lays-out when it plays. One cycle
 * — hold, then fade — and the fill is gone; under reduce-motion the hold is
 * the whole of it and the fill clears without animating.
 *
 * Mounting IS the trigger, and this only mounts for a landing, so a
 * re-render, a refresh or a live arrival replays nothing.
 */
function ArrivalFlashFill({ tint }: { tint: FlashTint }) {
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
      style={[
        tint === 'brass' ? styles.sourceLandingFlashGround : styles.arrivalFlashGround,
        groundStyle,
      ]}
      testID="arrival-flash-ground"
    />
  );
}

/** Marks the beginning of the unread run without an action. */
export function NewMessagesDivider() {
  return (
    <View
      accessibilityLabel="Unread messages begin here"
      accessibilityRole="text"
      style={styles.newMessages}
      testID="new-messages-divider"
    >
      <View style={styles.newMessagesRule} />
      <Text style={styles.newMessagesLabel}>NEW</Text>
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
  // A reader-initiated jump to one exact message (a quote reference, a
  // forward source, a notification target) reads as brass, not the passive
  // bgHighlight arrival pointer above — the existing token, never a new one.
  sourceLandingFlashGround: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.buzz.brassWashStrong,
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
  newMessagesLabel: { ...theme.buzz.type.sectionHead, color: theme.buzz.accent },
}));
