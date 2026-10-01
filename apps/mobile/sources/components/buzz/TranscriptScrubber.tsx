import * as Haptics from 'expo-haptics';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { ledgerMonth } from '@/buzz/message-dates';
import {
  nearestScrubberDay,
  scrubberBubble,
  type ScrubberDay,
  type ScrubberHistory,
} from '@/buzz/transcript-scrubber';

/** The right-edge strip that takes the press, wider than the bar it holds. */
export const SCRUBBER_STRIP_WIDTH = 44;
export const SCRUBBER_HOLD_MS = 250;
const BAR_HEIGHT = 36;
const HANDLE_HEIGHT = 44;
/** Movement that reads as a flick, not a hold, before the hold fires. */
const HOLD_SLOP = 8;

/**
 * The transcript's own scroll bar. It shows while the list scrolls, placed by
 * the whole history (`buzz/transcript-scrubber.ts`) rather than the loaded
 * rows, so a page of older messages cannot move it. Press and hold the right
 * edge to turn it into a handle: a rail of day markers appears, dragging snaps
 * to them, and releasing hands the day to the transcript to land on.
 */
export function TranscriptScrubber({
  history,
  position,
  visible,
  onScrub,
  onScrubEnd,
}: {
  history: ScrubberHistory;
  /** 0 at the newest message, 1 at the oldest; null hides the bar. */
  position: number | null;
  /** The list is scrolling or just stopped. */
  visible: boolean;
  onScrub: (day: ScrubberDay) => void;
  onScrubEnd: (day: ScrubberDay) => void;
}) {
  const [railHeight, setRailHeight] = useState(0);
  const [scrubDay, setScrubDay] = useState<ScrubberDay | null>(null);
  const live = useRef({ history, railHeight, onScrub, onScrubEnd });
  live.current = { history, railHeight, onScrub, onScrubEnd };
  const gesture = useRef<{
    startY: number;
    dy: number;
    timer: ReturnType<typeof setTimeout> | null;
    day: ScrubberDay | null;
  }>({ startY: 0, dy: 0, timer: null, day: null });

  useEffect(
    () => () => {
      if (gesture.current.timer) clearTimeout(gesture.current.timer);
    },
    [],
  );

  const pan = useMemo(() => {
    const dayAt = (y: number) => {
      const { history: current, railHeight: height } = live.current;
      if (height <= 0) return null;
      const clamped = Math.min(height, Math.max(0, y));
      return nearestScrubberDay(current.days, 1 - clamped / height);
    };
    const follow = (y: number) => {
      const day = dayAt(y);
      if (!day || day.key === gesture.current.day?.key) return;
      gesture.current.day = day;
      setScrubDay(day);
      void Haptics.selectionAsync();
      live.current.onScrub(day);
    };
    const cancelHold = () => {
      if (gesture.current.timer) clearTimeout(gesture.current.timer);
      gesture.current.timer = null;
    };
    const finish = () => {
      cancelHold();
      const day = gesture.current.day;
      gesture.current.day = null;
      setScrubDay(null);
      if (day) live.current.onScrubEnd(day);
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => live.current.history.days.length > 0,
      onPanResponderTerminationRequest: () => gesture.current.day === null,
      onPanResponderGrant: (event) => {
        gesture.current = {
          startY: event.nativeEvent.locationY,
          dy: 0,
          timer: setTimeout(() => {
            gesture.current.timer = null;
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            follow(gesture.current.startY + gesture.current.dy);
          }, SCRUBBER_HOLD_MS),
          day: null,
        };
      },
      onPanResponderMove: (_event, state) => {
        gesture.current.dy = state.dy;
        if (gesture.current.day) follow(gesture.current.startY + state.dy);
        else if (Math.abs(state.dy) > HOLD_SLOP) cancelHold();
      },
      onPanResponderRelease: finish,
      onPanResponderTerminate: finish,
    });
  }, []);

  const scrubbing = scrubDay !== null;
  const shown = scrubbing || (visible && position !== null);
  const handleTop = (at: number, size: number) =>
    Math.max(0, Math.min(railHeight - size, (1 - at) * railHeight - size / 2));
  const bubble = scrubDay ? scrubberBubble(scrubDay) : null;

  return (
    <View
      onLayout={(event) => setRailHeight(event.nativeEvent.layout.height)}
      pointerEvents={shown && history.days.length > 0 ? 'auto' : 'none'}
      style={styles.strip}
      testID="transcript-scrubber"
      {...pan.panHandlers}
    >
      {scrubbing && (
        <View pointerEvents="none" style={styles.rail} testID="transcript-scrubber-rail">
          {history.days.map((day) => (
            <View
              key={day.key}
              style={[styles.dayMarker, { top: (1 - day.position) * railHeight }]}
            >
              {day.monthStart && <Text style={styles.monthLabel}>{ledgerMonth(day.startsAt)}</Text>}
              <View style={styles.dayTick} />
            </View>
          ))}
        </View>
      )}
      {shown && !scrubbing && position !== null && (
        <View
          pointerEvents="none"
          style={[styles.bar, { top: handleTop(position, BAR_HEIGHT) }]}
          testID="transcript-scrubber-bar"
        />
      )}
      {scrubDay && bubble && (
        <>
          <View
            pointerEvents="none"
            style={[styles.handle, { top: handleTop(scrubDay.position, HANDLE_HEIGHT) }]}
            testID="transcript-scrubber-handle"
          />
          <View
            pointerEvents="none"
            style={[styles.bubble, { top: handleTop(scrubDay.position, HANDLE_HEIGHT) }]}
            testID="transcript-scrubber-bubble"
          >
            <Text style={styles.bubbleDate}>{bubble.date}</Text>
            <Text numberOfLines={1} style={styles.bubbleDetail}>
              {bubble.detail}
            </Text>
          </View>
        </>
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
    rail: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      right: 5,
      width: 1,
      backgroundColor: groknight.border,
    },
    dayMarker: {
      position: 'absolute',
      right: 0,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
    dayTick: {
      width: 5,
      height: 1,
      backgroundColor: groknight.borderStrong,
    },
    monthLabel: {
      ...groknight.type.sectionHead,
      fontFamily: groknight.monoSemibold,
      color: groknight.textMuted,
    },
    bar: {
      position: 'absolute',
      right: 3,
      width: 3,
      height: BAR_HEIGHT,
      borderRadius: 2,
      backgroundColor: groknight.textMuted,
    },
    handle: {
      position: 'absolute',
      right: 2,
      width: 6,
      height: HANDLE_HEIGHT,
      borderRadius: 3,
      backgroundColor: groknight.accent,
    },
    bubble: {
      position: 'absolute',
      right: SCRUBBER_STRIP_WIDTH,
      minWidth: 180,
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
    bubbleDetail: {
      ...groknight.type.meta,
      color: groknight.textPrimary,
    },
  };
});
