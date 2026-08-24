import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  type AppStateStatus,
  Pressable,
  type PressableProps,
  type StyleProp,
  Text,
  type TextStyle,
  View,
  type ViewProps,
  type ViewStyle,
} from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import * as Haptics from 'expo-haptics';
import Animated, {
  Easing,
  FadeInDown,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { groknight } from '@/buzz/groknight';
import { hasMessageRevealed, markMessageRevealed } from '@/buzz/message-reveal';
import { cornerVisualState, type CornerStatus, type CornerVisualState } from '@/buzz/corners';
import { Typography } from '@/constants/Typography';

export const motionTokens = {
  pressIn: 70,
  pressOut: 110,
  reveal: 176,
  confirm: 240,
  loaderFrame: 133,
  liveCycle: 1120,
  /**
   * How long a settled row takes to dip and come back when it demotes out of
   * its live form. Measured against grok Build: its rollup row swaps from the
   * present participle to the past tense in 52-104ms, which on a terminal is a
   * single repaint and reads as instantaneous. A silent substitution at that
   * speed is invisible on a phone — the eye is elsewhere — so the swap is given
   * a dip the eye can catch, then restored on the shared reveal easing.
   */
  demoteDip: 90,
} as const;

/**
 * The one separator a repeating list row is allowed: a single hairline,
 * never a border+fill+radius box. Spread into a row's own style alongside
 * that screen's background.
 */
export const hairlineDivider: ViewStyle = {
  borderBottomWidth: 1,
  borderBottomColor: groknight.border,
};

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
    transform: [{ scale: 1 - pressed.value * 0.015 }, { translateY: pressed.value }],
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
  /** Optional extra style for the label Text (e.g. a theme prose family override). */
  labelStyle?: StyleProp<TextStyle>;
};

export function MonoButton({
  label,
  loading = false,
  variant = 'primary',
  disabled,
  style,
  labelStyle,
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
            labelStyle,
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

export type HullDeckState = 'needs-you' | 'working' | 'idle';

/**
 * #419 unified the Room and corner treatments but accidentally promoted their
 * geometry to 20px/14px. Keep the unified vocabulary at the compact deck scale:
 * the Room mark restores the former 9px attention-dot footprint, and a corner
 * stays subordinate at 7px.
 */
export const stateCircleDiameter = { room: 9, corner: 7 } as const;

/**
 * The one state glyph used at BOTH hierarchy levels: hollow grey circle when
 * idle, grey ring with a rotating brass top arc while working, and a gently
 * pulsing filled brass circle when it needs you. The word exists only as
 * invisible accessibility metadata.
 */
export function StateCircle({
  state,
  scale = 'corner',
  style,
  testID,
}: {
  state: CornerVisualState;
  scale?: 'corner' | 'room';
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const reducedMotion = useReducedMotion();
  const rotation = useSharedValue(0);
  const { progress: pulseProgress, still: pulseStill } = useLiveCycle(state === 'needs-you');
  const spin = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value * 360}deg` }],
  }));
  const pulseRing = useAnimatedStyle(() => {
    if (pulseStill) return { opacity: 0, transform: [{ scale: 1 }] };
    const phase = Math.sin(pulseProgress.value * Math.PI);
    return {
      opacity: 0.28 * (1 - phase),
      transform: [{ scale: 1 + 0.55 * phase }],
    };
  });

  useEffect(() => {
    if (state !== 'working' || reducedMotion) {
      rotation.value = 0;
      return;
    }
    rotation.value = withRepeat(
      withTiming(1, {
        duration: 900,
        easing: Easing.linear,
        reduceMotion: ReduceMotion.System,
      }),
      -1,
      false,
    );
  }, [rotation, reducedMotion, state]);

  const diameter = stateCircleDiameter[scale];
  const geometry = { width: diameter, height: diameter, borderRadius: diameter / 2 };
  const mark =
    state === 'working' ? (
      <Animated.View
        style={[
          geometry,
          styles.stateCircleWorking,
          reducedMotion && styles.stateCircleWorkingStill,
          spin,
        ]}
      />
    ) : (
      <View
        style={[
          geometry,
          state === 'needs-you' ? styles.stateCircleNeedsYou : styles.stateCircleIdle,
        ]}
      />
    );
  return (
    <View
      accessible
      accessibilityLabel={state}
      accessibilityRole={state === 'working' ? 'progressbar' : 'image'}
      style={[styles.stateCircleSlot, geometry, style]}
      testID={testID}
    >
      {state === 'needs-you' && !reducedMotion && (
        <Animated.View
          pointerEvents="none"
          style={[geometry, styles.stateCircleNeedsYouPulse, pulseRing]}
        />
      )}
      {mark}
    </View>
  );
}

/** Room compatibility name: the room mark is the same circle component,
 * fed only by the max-severity rollup of its corners. */
export function HullDeckMark({ state }: { state: HullDeckState }) {
  return (
    <View style={styles.deckMarkSlot}>
      <StateCircle state={state} scale="room" />
    </View>
  );
}

type HullWaveSignalProps = {
  active?: boolean;
  label: 'LIVE' | 'WAITING' | 'RUNNING';
  compact?: boolean;
};

/**
 * The one continuous loop the app runs while it is on screen and unattended:
 * a linear 0→1 cycle other live primitives read a phase off. Kept here so
 * every "something is alive" signal in the product breathes on the same clock
 * and stops on the same conditions — reduced motion, or the app backgrounded.
 */
function useLiveCycle(active: boolean): { progress: SharedValue<number>; still: boolean } {
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

  return { progress, still: Boolean(reducedMotion || !active) };
}

export function HullWaveSignal({ active = true, label, compact = false }: HullWaveSignalProps) {
  const { progress, still } = useLiveCycle(active);
  // Gold means one thing product-wide: an agent is alive and working. LIVE is
  // that state; WAITING and RUNNING report the app's own progress, so they
  // stay on the grayscale signal tone.
  const alive = label === 'LIVE';

  const segments = useMemo(
    () => Array.from({ length: compact ? 6 : 9 }, (_, index) => index),
    [compact],
  );
  return (
    <View accessibilityLabel={label} accessibilityRole="text" style={styles.waveSignal}>
      <View style={styles.waveSegments}>
        {segments.map((index) => (
          <WaveSegment
            key={index}
            alive={alive}
            index={index}
            count={segments.length}
            progress={progress}
            staticState={still}
          />
        ))}
      </View>
      <Text style={styles.waveLabel}>{label}</Text>
    </View>
  );
}

function WaveSegment({
  alive,
  index,
  count,
  progress,
  staticState,
}: {
  alive: boolean;
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
  return <Animated.View style={[styles.waveSegment, alive && styles.waveSegmentLive, style]} />;
}

/** The dimmest the live pulse ever goes. High enough that the mark it carries
 * stays legible at every point in the cycle — a breath, not a blink. */
const LIVE_PULSE_FLOOR = 0.55;

/**
 * THE corner-state glyph, for every surface that names a corner: deck
 * expansion rows, corner lists, pinned references. This component is the only
 * thing that may draw a corner's state circle, with the same fill+motion
 * vocabulary as its Room.
 * No visible status word rides beside it.
 */
export function CornerGlyph({
  status,
  awaitingReply,
  agentOffline,
  style,
  testID,
}: {
  /** The oracle's verdict; `null` (stalled/idle) renders on the quiet tier. */
  status: CornerStatus | null;
  awaitingReply?: boolean;
  agentOffline?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  return (
    <StateCircle
      state={cornerVisualState(status, { awaitingReply, agentOffline })}
      style={style}
      testID={testID}
    />
  );
}

/**
 * The same live wave, reduced to a single mark: one slow sin² breath on
 * whatever it wraps, on `HullWaveSignal`'s clock. It exists so a dense index
 * row can carry the "an agent is alive here" signal at the size of one glyph
 * — a nine-segment wave in a 30px leading column would be noise, and a static
 * accent dot would not read as *live*.
 *
 * Motion is the redundant channel here, never the only one: what it wraps is
 * already the filled brass needs-you circle.
 * With reduced motion on, or the app backgrounded, it simply holds still.
 */
export function HullLivePulse({
  active = true,
  children,
  style,
}: {
  active?: boolean;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const { progress, still } = useLiveCycle(active);
  const pulse = useAnimatedStyle(() => {
    if (still) return { opacity: 1 };
    return {
      opacity: LIVE_PULSE_FLOOR + (1 - LIVE_PULSE_FLOOR) * Math.sin(progress.value * Math.PI) ** 2,
    };
  });
  return <Animated.View style={[style, pulse]}>{children}</Animated.View>;
}

/**
 * The one motion contract for a row that reports mechanism rather than voice.
 *
 * Two beats, both taken from watching grok Build work rather than from a
 * screenshot of it:
 *
 *   **Arrival is a pop, not a stream.** Narration reaches the reader by
 *   growing a phrase at a time (grok repaints one every ~130ms; Beeline's draft
 *   streamer coalesces at 250ms). A tool rollup does the opposite — it appears
 *   whole, in a single frame, already complete. That contrast is load-bearing:
 *   it is how a reader tells the agent's voice from the agent's receipts
 *   without reading either. So this enters on `reveal`, fast and eased-out,
 *   against narration that never enters at all.
 *
 *   **Demotion is a dip.** When the work settles the row rewrites itself from
 *   the present tense to the past. grok does that swap in ~100ms and gets away
 *   with a silent substitution because a terminal reader is watching one
 *   column; here the change is given a short dip so it registers as *the row
 *   changing state* rather than as text that was always that way.
 *
 * Reduced motion drops both beats and renders the settled row directly — the
 * tense of the copy still reports the state, which is why the motion is allowed
 * to be purely redundant.
 */
export function HullMechanismReveal({
  children,
  live,
  style,
}: {
  children: React.ReactNode;
  live: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const reducedMotion = useReducedMotion();
  // Only a row that arrives *while the work is live* is genuinely new. A
  // settled row is scrolled back into view constantly by the transcript's
  // recycling FlatList, and replaying the arrival pop every time it does would
  // turn a one-time signal into a twitch.
  const entered = useSharedValue(reducedMotion || !live ? 1 : 0);
  const settle = useSharedValue(1);
  // A ref, not state: this only ever gates an imperative animation, and making
  // it reactive would re-render the row on the very frame it is animating.
  const wasLive = React.useRef(live);

  useEffect(() => {
    if (entered.value === 1) return;
    entered.value = withTiming(1, {
      duration: motionTokens.reveal,
      easing: easeOutQuint,
      reduceMotion: ReduceMotion.System,
    });
    // Mount-only: `live` flipping later is the demote beat below, not a second
    // arrival, and re-running this would replay the pop on top of it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entered]);

  useEffect(() => {
    const demoted = wasLive.current && !live;
    wasLive.current = live;
    if (!demoted || reducedMotion) return;
    settle.value = withSequence(
      withTiming(0.4, { duration: motionTokens.demoteDip, easing: Easing.linear }),
      withTiming(1, { duration: motionTokens.reveal, easing: easeOutQuint }),
    );
  }, [live, reducedMotion, settle]);

  const animated = useAnimatedStyle(() => ({
    opacity: entered.value * settle.value,
    transform: [{ translateY: (1 - entered.value) * 3 }],
  }));

  return <Animated.View style={[style, animated]}>{children}</Animated.View>;
}

/**
 * The 2px gutter that says whether the row beside it is still happening.
 *
 * grok encodes exactly this in the weight of its rail — `┃` while a block is
 * the live one, `❙` once the next thing starts — and keeps the label itself
 * untouched, so a failure or an in-flight call never disturbs the reading
 * column. The port keeps the geometry and spends the reserved accent on the
 * live state only, which is the one thing `DESIGN.md` already assigns gold to.
 * The breath comes off the shared live clock, so this rail and every other
 * live signal in the product move together rather than beating against
 * each other.
 */
export function HullMechanismRail({ live }: { live: boolean }) {
  const rail = <View style={[styles.mechanismRail, live && styles.mechanismRailLive]} />;
  return live ? <HullLivePulse>{rail}</HullLivePulse> : rail;
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
        [0, 1, 2, 3].map((index) => <RevealStrip key={index} index={index} progress={progress} />)}
    </Animated.View>
  );
}

export function NewMessageMaterialize({
  children,
  enabled = true,
  messageId,
}: {
  children: React.ReactNode;
  enabled?: boolean;
  /** Stable message id. The entrance plays at most once per id per app
   *  session — never again on re-render, scroll-back remount, or Room re-entry.
   */
  messageId?: string;
}) {
  // Decided ONCE per mounted instance: a re-render while the entrance is
  // playing (presence tick, roster update) must not flip the wrapper and cut
  // the animation short. Cross-instance replay (FlatList recycling the row,
  // navigating back into the Room) is closed by the session reveal registry.
  const animateRef = useRef<boolean | null>(null);
  if (animateRef.current === null) {
    animateRef.current = enabled && (messageId === undefined || !hasMessageRevealed(messageId));
  }
  const animate = animateRef.current;
  // Mark after commit, not during render: a render that React discards must
  // not spend the message's one entrance.
  useEffect(() => {
    if (animate && messageId !== undefined) markMessageRevealed(messageId);
  }, [animate, messageId]);
  if (!animate) return <View>{children}</View>;
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

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return {
    hullSurface: { position: 'relative', overflow: 'hidden' },
    cornerGlyphLive: { color: groknight.accent },
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
    /**
     * Geometry, not chroma, carries the status: a fixed 2px column at the
     * mechanism indent, so a reader scans one edge instead of reading every
     * label. It is `alignSelf: 'stretch'` rather than a fixed height because the
     * row it marks can wrap.
     */
    mechanismRail: {
      width: 2,
      alignSelf: 'stretch',
      minHeight: 14,
      flexShrink: 0,
      backgroundColor: groknight.borderQuiet,
    },
    mechanismRailLive: { backgroundColor: groknight.accent },
    activityTip: { flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: 5 },
    /* ── Unified state circle: Room rollup and corner state ──────────── */
    deckMarkSlot: { width: 26, alignItems: 'center', justifyContent: 'center' },
    stateCircleSlot: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    stateCircleNeedsYou: {
      backgroundColor: groknight.accent,
    },
    stateCircleNeedsYouPulse: {
      position: 'absolute',
      borderWidth: 1,
      borderColor: groknight.accent,
    },
    stateCircleIdle: {
      borderWidth: 1,
      borderColor: groknight.steel,
      backgroundColor: 'transparent',
    },
    stateCircleWorking: {
      borderWidth: 1,
      borderColor: groknight.bgTexturePeak,
      borderTopColor: groknight.accent,
      backgroundColor: 'transparent',
    },
    stateCircleWorkingStill: {
      borderColor: groknight.steel,
      borderTopColor: groknight.steel,
    },
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
    waveSegmentLive: { backgroundColor: groknight.accent },
    waveLabel: {
      ...Typography.mono('semiBold'),
      color: groknight.textPrimary,
      fontSize: 11,
      lineHeight: 15,
      letterSpacing: 0.8,
    },
    revealStrip: { position: 'absolute', right: 0, left: 0, backgroundColor: groknight.bgRaised },
  };
});
