import * as Haptics from 'expo-haptics';
import React, { useMemo, useRef, useState } from 'react';
import { PanResponder, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { ledgerMonth } from '@/buzz/message-dates';
import {
  nearestScrubberDay,
  scrubberBubble,
  type ScrubberDay,
  type ScrubberHistory,
} from '@/buzz/transcript-scrubber';

/** The right-edge strip the bar runs in, wider than the bar it holds. */
export const SCRUBBER_STRIP_WIDTH = 44;
const BAR_HEIGHT = 36;
const HANDLE_HEIGHT = 44;
/** How far above and below the bar a press still takes it. */
const BAR_GRAB_SLOP = 12;

/**
 * The transcript's own scroll bar. It stays on screen whenever the reader's
 * place is known, so it can be grabbed without scrolling first, and is placed
 * by the whole history (`buzz/transcript-scrubber.ts`) rather than the loaded
 * rows, so a page of older messages cannot move it. Pressing the bar takes it
 * at once, as Android's fast-scroll thumb does, and turns it into a handle: a
 * rail of day markers appears, dragging snaps to them, and releasing hands the
 * day to the transcript to land on.
 *
 * Only the bar takes touches. The rest of the strip passes them to the list,
 * so a flick near the right edge scrolls the transcript while the bar shows.
 */
export function TranscriptScrubber({
  history,
  position,
  onScrub,
  onScrubEnd,
}: {
  history: ScrubberHistory;
  /** 0 at the newest message, 1 at the oldest; null hides the bar. */
  position: number | null;
  onScrub: (day: ScrubberDay) => void;
  onScrubEnd: (day: ScrubberDay) => void;
}) {
  const [railHeight, setRailHeight] = useState(0);
  const [scrubDay, setScrubDay] = useState<ScrubberDay | null>(null);
  // The bar is held: it stays mounted and shown until the finger lifts.
  const [grabbed, setGrabbed] = useState(false);
  const live = useRef({ history, position, railHeight, onScrub, onScrubEnd });
  live.current = { history, position, railHeight, onScrub, onScrubEnd };
  const gesture = useRef<{ startY: number; day: ScrubberDay | null }>({ startY: 0, day: null });

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
    const finish = () => {
      const day = gesture.current.day;
      gesture.current.day = null;
      setGrabbed(false);
      setScrubDay(null);
      if (day) live.current.onScrubEnd(day);
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => live.current.history.days.length > 0,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (event) => {
        const { position: at, railHeight: height } = live.current;
        // The grab target sits on the bar; its touch is measured from its own top.
        gesture.current = {
          startY: grabTop(at ?? 0, height) + event.nativeEvent.locationY,
          day: null,
        };
        setGrabbed(true);
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      },
      onPanResponderMove: (_event, state) => follow(gesture.current.startY + state.dy),
      onPanResponderRelease: finish,
      onPanResponderTerminate: finish,
    });
  }, []);

  const scrubbing = scrubDay !== null;
  const bubble = scrubDay ? scrubberBubble(scrubDay) : null;

  return (
    <View
      onLayout={(event) => setRailHeight(event.nativeEvent.layout.height)}
      pointerEvents="box-none"
      style={styles.strip}
      testID="transcript-scrubber"
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
      {!scrubbing && position !== null && (
        <View
          pointerEvents="none"
          style={[styles.bar, { top: handleTop(position, BAR_HEIGHT, railHeight) }]}
          testID="transcript-scrubber-bar"
        />
      )}
      {history.days.length > 0 && (position !== null || grabbed) && (
        <View
          // Never flattened away: Android needs a real view to take the touch.
          collapsable={false}
          style={[styles.grab, { top: grabTop(position ?? 0, railHeight) }]}
          testID="transcript-scrubber-grab"
          {...pan.panHandlers}
        />
      )}
      {scrubDay && bubble && (
        <>
          <View
            pointerEvents="none"
            style={[
              styles.handle,
              { top: handleTop(scrubDay.position, HANDLE_HEIGHT, railHeight) },
            ]}
            testID="transcript-scrubber-handle"
          />
          <View
            pointerEvents="none"
            style={[
              styles.bubble,
              { top: handleTop(scrubDay.position, HANDLE_HEIGHT, railHeight) },
            ]}
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

function handleTop(at: number, size: number, railHeight: number): number {
  return Math.max(0, Math.min(railHeight - size, (1 - at) * railHeight - size / 2));
}

/** The touch target over the bar, taller than the bar by the grab slop. */
function grabTop(at: number, railHeight: number): number {
  return handleTop(at, BAR_HEIGHT, railHeight) - BAR_GRAB_SLOP;
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
    grab: {
      position: 'absolute',
      right: 0,
      width: SCRUBBER_STRIP_WIDTH,
      height: BAR_HEIGHT + BAR_GRAB_SLOP * 2,
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
