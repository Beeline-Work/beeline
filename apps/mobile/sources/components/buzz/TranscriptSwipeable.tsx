import React, { forwardRef, useCallback, useImperativeHandle, useMemo } from 'react';
import { I18nManager, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { ReduceMotion, runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

export type TranscriptSwipeableMethods = { close(): void };
type Direction = 'left' | 'right';
type Props = {
  children: React.ReactNode;
  containerStyle?: StyleProp<ViewStyle>;
  childrenContainerStyle?: StyleProp<ViewStyle>;
  dragOffsetFromRightEdge?: number;
  friction?: number;
  enabled?: boolean;
  onSwipeableWillOpen?(direction: Direction): void;
  onSwipeableClose?(direction: Direction): void;
  onSwipeableOpenStartDrag?(): void;
  renderLeftActions?(): React.ReactNode;
  renderRightActions?(): React.ReactNode;
  testID?: string;
};

/** Transcript swipes commit one action and immediately return. They never
 * retain an open drawer, so they need neither a second tap recognizer nor
 * per-row drawer measurements/progress/retained-open animation state. */
const TranscriptSwipeable = forwardRef<TranscriptSwipeableMethods, Props>(function TranscriptSwipeable({
  children, containerStyle, childrenContainerStyle, dragOffsetFromRightEdge = 18,
  friction = 1.35, enabled = true, onSwipeableWillOpen, onSwipeableClose,
  onSwipeableOpenStartDrag, renderLeftActions, renderRightActions, testID,
}, ref) {
  const offset = useSharedValue(0);
  const left = Boolean(renderLeftActions);
  const right = Boolean(renderRightActions);
  const close = useCallback(() => {
    'worklet';
    const direction: Direction = offset.value < 0 ? 'right' : 'left';
    offset.value = withSpring(0, {
      mass: 2, damping: 1000, stiffness: 700, overshootClamping: true,
      reduceMotion: ReduceMotion.System,
    }, (finished) => { if (finished && onSwipeableClose) runOnJS(onSwipeableClose)(direction); });
  }, [offset, onSwipeableClose]);
  useImperativeHandle(ref, () => ({ close }), [close]);
  const pan = useMemo(() => Gesture.Pan()
    .enabled(enabled && (left || right))
    .activeOffsetX([-dragOffsetFromRightEdge, 10])
    .onStart(() => { if (onSwipeableOpenStartDrag) runOnJS(onSwipeableOpenStartDrag)(); })
    .onUpdate((event) => {
      offset.value = Math.max(right ? -ACTION_WIDTH : 0, Math.min(left ? ACTION_WIDTH : 0, event.translationX / friction));
    })
    .onEnd((event) => {
      // Match Swipeable's half-panel threshold and velocity projection.
      const projected = (event.translationX + 0.05 * event.velocityX) / friction;
      if (onSwipeableWillOpen && ((left && projected > ACTION_WIDTH / 2) || (right && projected < -ACTION_WIDTH / 2))) {
        runOnJS(onSwipeableWillOpen)(projected > 0 ? 'right' : 'left');
      }
    })
    // Cancellation by a scroll, interrupted touch, and committed actions all
    // return on the UI thread. No JS timer can strand a translated message.
    .onFinalize(close), [close, dragOffsetFromRightEdge, enabled, friction, left, offset, onSwipeableOpenStartDrag, onSwipeableWillOpen, right]);
  const contentStyle = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value }] }));
  const leftStyle = useAnimatedStyle(() => ({ opacity: offset.value > 0 ? 1 : 0 }));
  const rightStyle = useAnimatedStyle(() => ({ opacity: offset.value < 0 ? 1 : 0 }));
  return (
    <View testID={testID}>
      <GestureDetector gesture={pan} touchAction="pan-y">
        <View style={[styles.container, containerStyle]}>
          {left ? <Animated.View style={[styles.leftActions, leftStyle]}>{renderLeftActions?.()}</Animated.View> : null}
          {right ? <Animated.View style={[styles.rightActions, rightStyle]}>{renderRightActions?.()}</Animated.View> : null}
          <Animated.View style={[contentStyle, childrenContainerStyle]}>{children}</Animated.View>
        </View>
      </GestureDetector>
    </View>
  );
});

const ACTION_WIDTH = 78;
const styles = StyleSheet.create({
  container: { overflow: 'hidden' },
  leftActions: { ...StyleSheet.absoluteFillObject, flexDirection: I18nManager.isRTL ? 'row-reverse' : 'row', overflow: 'hidden' },
  rightActions: { ...StyleSheet.absoluteFillObject, flexDirection: I18nManager.isRTL ? 'row' : 'row-reverse', overflow: 'hidden' },
});

export default TranscriptSwipeable;
