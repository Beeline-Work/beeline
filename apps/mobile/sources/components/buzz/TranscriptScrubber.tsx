import * as Haptics from 'expo-haptics';
import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { PanResponder, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { scrollBarPosition, scrubOffset } from '@/buzz/transcript-scrubber';
import type { TranscriptScrubberStore } from '@/buzz/use-transcript-scrubber';

/** The thumb's touch target, wider and taller than the bar it holds. */
export const SCRUBBER_STRIP_WIDTH = 44;
const BAR_HEIGHT = 36;
const GRAB_HEIGHT = 64;

/**
 * The transcript's own scroll bar. It shows while the list scrolls, placed by
 * the list's offset over the rows the phone has loaded. Grab it and drag: the
 * list scrolls with the finger, and a bubble names the day on screen. Only the
 * thumb takes touches; the rest of the right edge belongs to the list.
 */
export function TranscriptScrubber({
  scrubber,
  onScrubTo,
}: {
  scrubber: TranscriptScrubberStore;
  /** Scroll the list to this offset. */
  onScrubTo: (offset: number) => void;
}) {
  const { metrics, date, visible } = useSyncExternalStore(scrubber.subscribe, scrubber.getSnapshot);
  const [railHeight, setRailHeight] = useState(0);
  // The thumb follows the finger while dragging, not the list's echo.
  const [dragPosition, setDragPosition] = useState<number | null>(null);
  const position = dragPosition ?? (metrics ? scrollBarPosition(metrics) : null);
  const live = useRef({ position, dragPosition, railHeight, onScrubTo });
  live.current = { position, dragPosition, railHeight, onScrubTo };
  const grabbedAt = useRef(0);

  // Rows that load under a held finger change the list's size, not its
  // offset. Re-aim the list so the finger keeps its place in the new range:
  // held at the top, that is the new oldest row, which loads the next page.
  const contentHeight = metrics?.contentHeight;
  const viewportHeight = metrics?.viewportHeight;
  useEffect(() => {
    const held = live.current.dragPosition;
    const current = scrubber.getSnapshot().metrics;
    if (held === null || !current) return;
    live.current.onScrubTo(scrubOffset(current, held));
  }, [contentHeight, viewportHeight, scrubber]);

  const pan = useMemo(() => {
    const finish = () => {
      setDragPosition(null);
      scrubber.reveal();
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
        const current = scrubber.getSnapshot().metrics;
        if (track <= 0 || !current) return;
        // Up the screen is older: position grows as dy goes negative.
        const next = Math.min(1, Math.max(0, grabbedAt.current - state.dy / track));
        setDragPosition(next);
        live.current.onScrubTo(scrubOffset(current, next));
      },
      onPanResponderRelease: finish,
      onPanResponderTerminate: finish,
    });
  }, [scrubber]);

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
      width: SCRUBBER_STRIP_WIDTH,
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
      marginRight: 3,
      width: 3,
      height: BAR_HEIGHT,
      borderRadius: 2,
      backgroundColor: groknight.textMuted,
    },
    handle: {
      marginRight: 2,
      width: 6,
      borderRadius: 3,
      backgroundColor: groknight.accent,
    },
    bubble: {
      position: 'absolute',
      right: SCRUBBER_STRIP_WIDTH,
      paddingHorizontal: 10,
      paddingVertical: 6,
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
