import * as Haptics from 'expo-haptics';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { PanResponder, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type {
  TranscriptScrollController,
  TranscriptScrollRow,
} from '@/buzz/transcript-scroll-controller';
import {
  scrollBarPosition,
  scrubOffset,
  scrubReachesOldest,
  type TranscriptScrollMetrics,
} from '@/buzz/transcript-scrubber';
import type { RoomMessagePositions } from '@/buzz/room-message-store';

/** The thumb's touch target, wider and taller than the bar it holds. */
export const SCRUBBER_STRIP_WIDTH = 44;
const BAR_HEIGHT = 36;
const GRAB_HEIGHT = 64;
const BAR_WIDTH = 3;
const HANDLE_WIDTH = 6;

/**
 * The transcript's own scroll bar. It shows while the list scrolls, placed by
 * the list's offset over the rows the phone has loaded. Grab it and drag: the
 * list scrolls with the finger, and a bubble names the day on screen. Only the
 * thumb takes touches; the rest of the right edge belongs to the list.
 *
 * The bar reads where the list is from the Room message store's `positions`
 * and asks the store for older rows when a scrub reaches the oldest loaded
 * ones. The scroll controller moves the list; the bar only requests an offset.
 */
export function TranscriptScrubber({
  positions,
  loadOlder,
  scrollController,
}: {
  /** The Room message store's `positions`. */
  positions: RoomMessagePositions;
  /** The Room message store's older page. */
  loadOlder: () => void;
  scrollController: Pick<TranscriptScrollController<TranscriptScrollRow>, 'request'>;
}) {
  const { metrics, date, visible } = useSyncExternalStore(
    positions.subscribe,
    positions.getSnapshot,
  );
  const [railHeight, setRailHeight] = useState(0);
  // The thumb follows the finger while dragging, not the list's echo.
  const [dragPosition, setDragPosition] = useState<number | null>(null);
  const position = dragPosition ?? (metrics ? scrollBarPosition(metrics) : null);
  const live = useRef({ position, dragPosition, railHeight, scrollController, loadOlder });
  live.current = { position, dragPosition, railHeight, scrollController, loadOlder };
  const grabbedAt = useRef(0);

  const scrubTo = useCallback((metrics: TranscriptScrollMetrics, next: number) => {
    const offset = scrubOffset(metrics, next);
    live.current.scrollController.request({ kind: 'offset', offset });
    if (scrubReachesOldest(metrics, offset)) live.current.loadOlder();
  }, []);

  // Older rows that load under a finger held at the top change the list's
  // size, not its offset. Re-aim the list at the new oldest row and ask for
  // the next page. Held anywhere else, the list stays put: rows measuring,
  // a new message or the keyboard must not move it under a still finger.
  const contentHeight = metrics?.contentHeight;
  const viewportHeight = metrics?.viewportHeight;
  useEffect(() => {
    const held = live.current.dragPosition;
    const current = positions.getSnapshot().metrics;
    if (held === null || held < 1 || !current) return;
    scrubTo(current, held);
  }, [contentHeight, viewportHeight, positions, scrubTo]);

  const pan = useMemo(() => {
    const finish = () => {
      setDragPosition(null);
      positions.reveal();
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        grabbedAt.current = live.current.position ?? 0;
        setDragPosition(grabbedAt.current);
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      },
      onPanResponderMove: (_event, state) => {
        const track = live.current.railHeight - BAR_HEIGHT;
        const current = positions.getSnapshot().metrics;
        if (track <= 0 || !current) return;
        // Up the screen is older: position grows as dy goes negative.
        const next = Math.min(1, Math.max(0, grabbedAt.current - state.dy / track));
        setDragPosition(next);
        scrubTo(current, next);
      },
      onPanResponderRelease: finish,
      onPanResponderTerminate: finish,
    });
  }, [positions, scrubTo]);

  const dragging = dragPosition !== null;
  const shown = position !== null && (visible || dragging);
  const top = position === null ? 0 : (1 - position) * Math.max(0, railHeight - BAR_HEIGHT);

  return (
    <View
      onLayout={(event) => setRailHeight(event.nativeEvent.layout.height)}
      pointerEvents="box-none"
      style={styles.strip}
      testID="transcript-scrubber"
    >
      {shown && (
        <View
          style={[styles.grab, { top: top - (GRAB_HEIGHT - BAR_HEIGHT) / 2 }]}
          testID="transcript-scrubber-grab"
          {...pan.panHandlers}
        >
          <View
            pointerEvents="none"
            style={[styles.bar, dragging && styles.handle]}
            testID="transcript-scrubber-bar"
          />
        </View>
      )}
      {shown && dragging && date && (
        <View
          pointerEvents="none"
          style={[styles.bubble, { top }]}
          testID="transcript-scrubber-bubble"
        >
          <Text style={styles.bubbleDate}>{date}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return {
    strip: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      // The date bubble needs the transcript's width to size to its text.
      left: 0,
    },
    grab: {
      position: 'absolute',
      right: 0,
      width: SCRUBBER_STRIP_WIDTH,
      height: GRAB_HEIGHT,
      justifyContent: 'center',
      alignItems: 'flex-end',
    },
    bar: {
      marginRight: groknight.space.xs + (HANDLE_WIDTH - BAR_WIDTH) / 2,
      width: BAR_WIDTH,
      height: BAR_HEIGHT,
      borderRadius: BAR_WIDTH / 2,
      backgroundColor: groknight.textMuted,
    },
    handle: {
      marginRight: groknight.space.xs,
      width: HANDLE_WIDTH,
      borderRadius: 3,
      backgroundColor: groknight.accent,
    },
    bubble: {
      position: 'absolute',
      right: SCRUBBER_STRIP_WIDTH,
      paddingHorizontal: groknight.space.sm,
      paddingVertical: groknight.space.sm,
      borderWidth: 1,
      borderColor: groknight.borderStrong,
      borderRadius: groknight.radius,
      backgroundColor: groknight.bgBase,
    },
    bubbleDate: {
      ...groknight.type.sectionHead,
      fontFamily: groknight.monoSemibold,
      color: groknight.accent,
    },
  };
});
