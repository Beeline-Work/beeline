import React, { useEffect, useMemo, useState } from 'react';
import {
  AppState,
  type AppStateStatus,
  Pressable,
  type PressableProps,
  type StyleProp,
  StyleSheet,
  Text,
  View,
  type ViewProps,
  type ViewStyle,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import Animated, {
  Easing,
  FadeInDown,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { groknight } from '@/buzz/groknight';
import { Typography } from '@/constants/Typography';

export const motionTokens = {
  pressIn: 70,
  pressOut: 110,
  reveal: 176,
  confirm: 240,
  loaderFrame: 133,
  liveCycle: 1120,
} as const;

const easeOutQuint = Easing.out(Easing.poly(5));

type HullSurfaceProps = Omit<ViewProps, 'children' | 'style'> & {
  children?: React.ReactNode;
  strength?: 'quiet' | 'raised' | 'code';
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

const SCRATCHES = [7, 15, 24, 31, 40, 48, 57, 66, 74, 83, 91];

export function HullSurface({
  children,
  strength = 'quiet',
  style,
  testID,
  ...props
}: HullSurfaceProps) {
  return (
    <View {...props} style={[styles.hullSurface, style]} testID={testID}>
      <View pointerEvents="none" style={styles.textureLayer}>
        {SCRATCHES.map((top, index) => (
          <View
            key={top}
            style={[
              styles.scratch,
              { left: `${(index * 17) % 31}%`, right: `${(index * 11) % 27}%`, top: `${top}%` },
            ]}
          />
        ))}
        {strength !== 'quiet' && (
          <>
            <View style={[styles.fleck, { left: '13%', top: '27%' }]} />
            <View style={[styles.fleck, { right: '19%', top: '64%' }]} />
            <View style={styles.raisedEdge} />
          </>
        )}
        {strength === 'code' && (
          <>
            <View style={[styles.codeNotch, styles.codeNotchTop]} />
            <View style={[styles.codeNotch, styles.codeNotchBottom]} />
          </>
        )}
      </View>
      {children}
    </View>
  );
}

type BrittlePressProps = Omit<PressableProps, 'children' | 'style'> & {
  children: React.ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
  highValue?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function BrittlePress({
  children,
  contentStyle,
  highValue = false,
  onPressIn,
  onPressOut,
  onPress,
  style,
  disabled,
  ...props
}: BrittlePressProps) {
  const pressed = useSharedValue(0);
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { scale: 1 - pressed.value * 0.015 },
      { translateY: pressed.value },
    ],
  }));

  return (
    <Animated.View style={[style, animatedStyle]}>
      <Pressable
        {...props}
        disabled={disabled}
        onPressIn={(event) => {
          pressed.value = withTiming(1, {
            duration: motionTokens.pressIn,
            easing: easeOutQuint,
            reduceMotion: ReduceMotion.System,
          });
          onPressIn?.(event);
        }}
        onPressOut={(event) => {
          pressed.value = withTiming(0, {
            duration: motionTokens.pressOut,
            easing: easeOutQuint,
            reduceMotion: ReduceMotion.System,
          });
          onPressOut?.(event);
        }}
        onPress={(event) => {
          if (highValue) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onPress?.(event);
        }}
        style={({ pressed: isPressed }) => [
          styles.pressTarget,
          contentStyle,
          isPressed && styles.pressTargetPressed,
          disabled && styles.pressTargetDisabled,
        ]}
      >
        {children}
      </Pressable>
    </Animated.View>
  );
}

type MonoButtonProps = Omit<BrittlePressProps, 'children'> & {
  label: string;
  loading?: boolean;
  variant?: 'primary' | 'secondary' | 'destructive';
};

export function MonoButton({
  label,
  loading = false,
  variant = 'primary',
  disabled,
  style,
  ...props
}: MonoButtonProps) {
  const isDisabled = Boolean(disabled || loading);
  return (
    <BrittlePress
      {...props}
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      disabled={isDisabled}
      highValue={variant === 'primary'}
      style={[styles.monoButtonFrame, style]}
    >
      <HullSurface
        strength={variant === 'primary' ? 'raised' : 'quiet'}
        style={[
          styles.monoButton,
          variant === 'primary' ? styles.primaryButton : styles.secondaryButton,
          variant === 'destructive' && styles.destructiveButton,
          isDisabled && styles.disabledButton,
        ]}
      >
        {loading && <PixelLoader compact />}
        <Text
          style={[
            styles.monoButtonText,
            variant === 'primary' ? styles.primaryButtonText : styles.secondaryButtonText,
            isDisabled && styles.disabledButtonText,
          ]}
        >
          {label}
        </Text>
      </HullSurface>
    </BrittlePress>
  );
}

export function PixelLoader({ compact = false }: { compact?: boolean }) {
  const reducedMotion = useReducedMotion();
  const frame = useSharedValue(0);

  useEffect(() => {
    if (reducedMotion) return;
    frame.value = withRepeat(
      withTiming(4, {
        duration: motionTokens.loaderFrame * 4,
        easing: Easing.linear,
        reduceMotion: ReduceMotion.System,
      }),
      -1,
      false,
    );
  }, [frame, reducedMotion]);

  return (
    <View
      accessibilityLabel="Loading"
      accessibilityRole="progressbar"
      style={[styles.pixelLoader, compact && styles.pixelLoaderCompact]}
    >
      {reducedMotion ? (
        <Text style={styles.staticLoader}>◇</Text>
      ) : (
        [0, 1, 2, 3].map((index) => (
          <LoaderCell key={index} frame={frame} index={index} compact={compact} />
        ))
      )}
    </View>
  );
}

/** One restrained live tip for a streaming activity timeline. */
export function HullActivityTip({ label = 'working…' }: { label?: string }) {
  const reducedMotion = useReducedMotion();
  const opacity = useSharedValue(1);

  useEffect(() => {
    if (reducedMotion) {
      opacity.value = 1;
      return;
    }
    opacity.value = withRepeat(
      withTiming(0.28, {
        duration: motionTokens.liveCycle,
        easing: easeOutQuint,
        reduceMotion: ReduceMotion.System,
      }),
      -1,
      true,
    );
  }, [opacity, reducedMotion]);

  const dotStyle = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <View accessibilityLabel={label} accessibilityRole="progressbar" style={styles.activityTip}>
      <Animated.View style={[styles.activityTipDot, dotStyle]} />
      <Text style={styles.activityTipLabel}>{label}</Text>
    </View>
  );
}

function LoaderCell({
  frame,
  index,
  compact,
}: {
  frame: SharedValue<number>;
  index: number;
  compact: boolean;
}) {
  const style = useAnimatedStyle(() => {
    const active = Math.floor(frame.value) % 4 === index;
    return { opacity: active ? 1 : 0.28 };
  });
  return <Animated.View style={[styles.loaderCell, compact && styles.loaderCellCompact, style]} />;
}

type HullWaveSignalProps = {
  active?: boolean;
  label: 'LIVE' | 'WAITING' | 'RUNNING';
  compact?: boolean;
};

export function HullWaveSignal({ active = true, label, compact = false }: HullWaveSignalProps) {
  const reducedMotion = useReducedMotion();
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const progress = useSharedValue(0);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      setAppActive(state === 'active');
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!active || !appActive || reducedMotion) {
      progress.value = 0;
      return;
    }
    progress.value = withRepeat(
      withTiming(1, {
        duration: motionTokens.liveCycle,
        easing: Easing.linear,
        reduceMotion: ReduceMotion.System,
      }),
      -1,
      false,
    );
  }, [active, appActive, progress, reducedMotion]);

  const segments = useMemo(() => Array.from({ length: compact ? 6 : 9 }, (_, index) => index), [compact]);
  return (
    <View accessibilityLabel={label} accessibilityRole="text" style={styles.waveSignal}>
      <View style={styles.waveSegments}>
        {segments.map((index) => (
          <WaveSegment
            key={index}
            index={index}
            count={segments.length}
            progress={progress}
            staticState={Boolean(reducedMotion || !active)}
          />
        ))}
      </View>
      <Text style={styles.waveLabel}>{label}</Text>
    </View>
  );
}

function WaveSegment({
  index,
  count,
  progress,
  staticState,
}: {
  index: number;
  count: number;
  progress: SharedValue<number>;
  staticState: boolean;
}) {
  const style = useAnimatedStyle(() => {
    if (staticState) return { opacity: index === 0 ? 1 : 0.3 };
    const phase = progress.value * Math.PI * 2 + (index / count) * Math.PI * 2;
    return { opacity: 0.3 + 0.7 * Math.sin(phase) ** 2 };
  });
  return <Animated.View style={[styles.waveSegment, style]} />;
}

export function PixelGateReveal({ children, style }: HullSurfaceProps) {
  const reducedMotion = useReducedMotion();
  const progress = useSharedValue(reducedMotion ? 1 : 0);

  useEffect(() => {
    progress.value = withTiming(1, {
      duration: motionTokens.reveal,
      easing: easeOutQuint,
      reduceMotion: ReduceMotion.System,
    });
  }, [progress]);

  const contentStyle = useAnimatedStyle(() => ({ opacity: progress.value }));
  return (
    <Animated.View style={[style, contentStyle]}>
      {children}
      {!reducedMotion &&
        [0, 1, 2, 3].map((index) => (
          <RevealStrip key={index} index={index} progress={progress} />
        ))}
    </Animated.View>
  );
}

export function NewMessageMaterialize({
  children,
  enabled = true,
}: {
  children: React.ReactNode;
  enabled?: boolean;
}) {
  if (!enabled) return <View>{children}</View>;
  return (
    <Animated.View
      entering={FadeInDown.duration(140)
        .easing(easeOutQuint)
        .reduceMotion(ReduceMotion.System)
        .withInitialValues({ opacity: 0, transform: [{ translateY: 3 }] })}
    >
      {children}
    </Animated.View>
  );
}

function RevealStrip({ index, progress }: { index: number; progress: SharedValue<number> }) {
  const style = useAnimatedStyle(() => ({
    opacity: 1 - progress.value,
    transform: [{ translateX: (index % 2 === 0 ? -4 : 4) * progress.value }],
  }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.revealStrip, { top: `${index * 25}%`, height: '25%' }, style]}
    />
  );
}

const styles = StyleSheet.create({
  hullSurface: { position: 'relative', overflow: 'hidden' },
  textureLayer: { ...StyleSheet.absoluteFillObject, opacity: 1 },
  scratch: {
    position: 'absolute',
    height: StyleSheet.hairlineWidth,
    backgroundColor: groknight.bgTexturePeak,
    opacity: 0.03,
  },
  fleck: {
    position: 'absolute',
    width: 1,
    height: 2,
    backgroundColor: groknight.steel,
    opacity: 0.025,
  },
  raisedEdge: {
    position: 'absolute',
    top: 0,
    right: 0,
    left: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: groknight.focus,
    opacity: 0.03,
  },
  codeNotch: {
    position: 'absolute',
    width: 8,
    height: 2,
    backgroundColor: groknight.borderStrong,
    opacity: 0.7,
  },
  codeNotchTop: { top: 0, left: 0 },
  codeNotchBottom: { right: 0, bottom: 0 },
  pressTarget: { minWidth: 44, minHeight: 44 },
  pressTargetPressed: { backgroundColor: groknight.bgPressed },
  pressTargetDisabled: { backgroundColor: groknight.bgBase },
  monoButtonFrame: { minHeight: 46 },
  monoButton: {
    minHeight: 46,
    paddingHorizontal: 16,
    borderRadius: 3,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  primaryButton: { backgroundColor: groknight.actionFill, borderColor: groknight.actionFill },
  secondaryButton: { backgroundColor: groknight.bgBase, borderColor: groknight.borderStrong },
  destructiveButton: { borderStyle: 'dashed', borderColor: groknight.borderStrong },
  disabledButton: { backgroundColor: groknight.bgBase, borderColor: groknight.border },
  monoButtonText: { ...Typography.default('semiBold'), fontSize: 13, lineHeight: 18 },
  primaryButtonText: { color: groknight.textInverted },
  secondaryButtonText: { color: groknight.textSecondary },
  disabledButtonText: { color: groknight.textDisabled },
  pixelLoader: { width: 42, height: 14, flexDirection: 'row', alignItems: 'center', gap: 4 },
  pixelLoaderCompact: { width: 30, height: 10, gap: 3 },
  loaderCell: { width: 7, height: 7, backgroundColor: groknight.signalBright },
  loaderCellCompact: { width: 5, height: 5 },
  staticLoader: { ...Typography.mono('semiBold'), color: groknight.signalBright, fontSize: 12 },
  activityTip: { flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: 5 },
  activityTipDot: { width: 5, height: 5, backgroundColor: groknight.accent },
  activityTipLabel: {
    ...Typography.mono(),
    color: groknight.accent,
    fontSize: 9,
    lineHeight: 12,
  },
  waveSignal: { minHeight: 20, flexDirection: 'row', alignItems: 'center', gap: 6 },
  waveSegments: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  waveSegment: { width: 3, height: 6, backgroundColor: groknight.signalBright },
  waveLabel: {
    ...Typography.mono('semiBold'),
    color: groknight.textPrimary,
    fontSize: 11,
    lineHeight: 15,
    letterSpacing: 0.8,
  },
  revealStrip: { position: 'absolute', right: 0, left: 0, backgroundColor: groknight.bgRaised },
});
