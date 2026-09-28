import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  BackHandler,
  findNodeHandle,
  Platform,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import {
  TOUR_TIP_IDS,
  loadProductTour,
  markTourTipSeen,
  replayProductTour,
  subscribeProductTour,
  tourTipDue,
  type ProductTourState,
  type TourTipId,
} from '@/buzz/product-tour';
import { hasArea, spotlightLayout, type TourRect } from '@/buzz/tour-geometry';
import {
  ActiveTourTargetContext,
  ProductTourContext,
  SeenTourTipsContext,
  type ProductTourContextValue,
  type TargetEntry,
} from './TourTarget';
import { Typography } from '@/constants/Typography';
import { OnboardingButton } from '@/components/buzz/MonoHull';

/**
 * Beeline's first-sight tips: a deliberately small in-tree overlay on
 * components the app already ships (every off-the-shelf tour engine failed
 * the Expo 55 / Fabric / web spike).
 *
 * - Three independent tips, each for something a person cannot see on the
 *   screen: swiping a message into a corner, pressing and holding a Room's
 *   corner mark, and what Trusty Squire does. There is no sequence, counter,
 *   or overview; each shows once, the first time its target is on screen.
 * - The overlay is drawn after the app's own content and beneath any sheet:
 *   a Hull sheet opened while a tip shows stacks above it, never under it. A
 *   tip appears only once its real target has mounted and measured to a
 *   non-zero rect, one at a time, and hides the moment that target unmounts
 *   (it stays due for the next encounter).
 * - "Got it", Escape (web) and back (Android) retire a tip; screen-reader
 *   focus moves to it; every control is at least 44pt; reduced motion drops
 *   the fade.
 */

export type TourTipCopy = {
  readonly title: string;
  readonly body: string;
  readonly bullets?: readonly string[];
  readonly closing?: string;
};

export const TOUR_TIP_COPY: Record<TourTipId, TourTipCopy> = {
  swipe: {
    title: 'Swipe right to open a corner',
    body: "A corner is a side space for one task. Swipe a message right and it's copied into a new corner, ready to send. Swipe left to reply.",
  },
  cornerMark: {
    title: 'This Room has corners',
    body: 'Tap the mark to see them. Press and hold it to open a new corner in this Room.',
  },
  squire: {
    title: 'Trusty Squire: sign-ups and keys',
    body: 'Link Google once. After that, agents can:',
    bullets: [
      'sign up for a service for you and save its API key',
      'use saved keys to call APIs, without ever seeing the key',
      "sign in to sites with logins you've saved",
    ],
    closing: 'Showing a key to anyone needs your passkey.',
  },
};

export function ProductTourProvider({ children }: { children: React.ReactNode }) {
  const [viewer, setViewer] = useState<string | null>(null);
  const [state, setState] = useState<ProductTourState | null>(null);
  const [layoutTick, setLayoutTick] = useState(0);
  // A stack per tip, not one entry: two layouts can both mark the same tip
  // (the phone Room list and the persistent desktop sidebar can be mounted
  // together in the native shell), and the one that leaves must not take the
  // still-mounted one's registration with it.
  const targets = useRef(new Map<TourTipId, TargetEntry[]>());
  const [targetIds, setTargetIds] = useState<readonly TourTipId[]>([]);
  const [activeEntry, setActiveEntry] = useState<TargetEntry | null>(null);

  // The viewer is re-read whenever a target registers, so a sign-in or
  // identity change is picked up without any extra wiring.
  const refreshViewer = useCallback(() => {
    void loadBuzzIdentity()
      .then((identity) => setViewer(identity?.publicKey ?? null))
      .catch(() => setViewer(null));
  }, []);

  useEffect(() => {
    if (!viewer) {
      setState(null);
      return;
    }
    let live = true;
    void loadProductTour(viewer).then((next) => live && setState(next));
    const unsubscribe = subscribeProductTour(viewer, (next) => live && setState(next));
    return () => {
      live = false;
      unsubscribe();
    };
  }, [viewer]);

  const registerTarget = useCallback(
    (tip: TourTipId, entry: TargetEntry) => {
      // A transcript can register one target per message: only the first
      // target of a tip changes which tips are on screen.
      const first = !targets.current.has(tip);
      targets.current.set(tip, [...(targets.current.get(tip) ?? []), entry]);
      if (first) {
        setTargetIds([...targets.current.keys()]);
        refreshViewer();
      }
      setLayoutTick((tick) => tick + 1);
      return () => {
        const held = (targets.current.get(tip) ?? []).filter((other) => other !== entry);
        if (held.length) targets.current.set(tip, held);
        else {
          targets.current.delete(tip);
          setTargetIds([...targets.current.keys()]);
        }
        setLayoutTick((tick) => tick + 1);
      };
    },
    [refreshViewer],
  );

  const context = useMemo<ProductTourContextValue>(
    () => ({
      registerTarget,
      targetLaidOut: () => setLayoutTick((tick) => tick + 1),
      replay: async (pubkey: string) => {
        setViewer(pubkey);
        setState(await replayProductTour(pubkey));
      },
    }),
    [registerTarget],
  );

  const activeTip =
    viewer && state
      ? (TOUR_TIP_IDS.find((tip) => targetIds.includes(tip) && tourTipDue(state, tip)) ?? null)
      : null;

  return (
    <ProductTourContext.Provider value={context}>
      <SeenTourTipsContext.Provider value={state?.seenTips ?? null}>
        <ActiveTourTargetContext.Provider value={activeTip ? activeEntry : null}>
          <View style={styles.root}>
            {children}
            {activeTip && viewer ? (
              <TourSpotlight
                key={activeTip}
                layoutTick={layoutTick}
                entries={() => targets.current.get(activeTip) ?? []}
                onTarget={setActiveEntry}
                onDone={() => void markTourTipSeen(viewer, activeTip)}
                tip={activeTip}
              />
            ) : null}
          </View>
        </ActiveTourTargetContext.Provider>
      </SeenTourTipsContext.Provider>
    </ProductTourContext.Provider>
  );
}

function TourSpotlight({
  tip,
  entries,
  layoutTick,
  onTarget,
  onDone,
}: {
  tip: TourTipId;
  entries: () => readonly TargetEntry[];
  layoutTick: number;
  onTarget: (entry: TargetEntry | null) => void;
  onDone: () => void;
}) {
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const [target, setTarget] = useState<TourRect | null>(null);
  const [tipHeight, setTipHeight] = useState(160);
  const tipRef = useRef<View>(null);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  const onTargetRef = useRef(onTarget);
  onTargetRef.current = onTarget;
  const copy = TOUR_TIP_COPY[tip];
  const spoken = [copy.body, ...(copy.bullets ?? []), copy.closing].filter(Boolean).join(' ');

  // Re-measure on every target layout and window resize. Of the targets on
  // screen the tip points at the topmost one wholly in view, else the topmost
  // partly in view: a transcript's lowest rows can sit under the composer
  // floating over the list. An unmeasurable target (unmounted, zero-sized,
  // off screen) shows nothing at all.
  useEffect(() => {
    let live = true;
    const candidates = entriesRef.current();
    void Promise.all(candidates.map((entry) => entry.measure())).then((rects) => {
      if (!live) return;
      let chosen: { entry: TargetEntry; rect: TourRect; whole: boolean } | null = null;
      rects.forEach((rect, index) => {
        const visible =
          hasArea(rect) &&
          rect.y + rect.height > 0 &&
          rect.y < window.height &&
          rect.x + rect.width > 0 &&
          rect.x < window.width;
        if (!visible) return;
        const whole =
          rect.y >= 0 &&
          rect.y + rect.height <= window.height &&
          rect.x >= 0 &&
          rect.x + rect.width <= window.width;
        const better =
          !chosen || (whole && !chosen.whole) || (whole === chosen.whole && rect.y < chosen.rect.y);
        if (better) chosen = { entry: candidates[index]!, rect, whole };
      });
      const picked = chosen as { entry: TargetEntry; rect: TourRect; whole: boolean } | null;
      onTargetRef.current(picked?.entry ?? null);
      setTarget((current) =>
        !picked
          ? null
          : current &&
              current.x === picked.rect.x &&
              current.y === picked.rect.y &&
              current.width === picked.rect.width &&
              current.height === picked.rect.height
            ? current
            : picked.rect,
      );
    });
    return () => {
      live = false;
    };
  }, [layoutTick, window.height, window.width]);

  const shown = target !== null;

  // Screen-reader and keyboard focus move to the tip once it is on screen
  // (a frame later: the entering fade mounts it after this commit).
  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => {
      const node = tipRef.current;
      if (Platform.OS === 'web') {
        (node as unknown as { focus?: () => void } | null)?.focus?.();
      } else {
        const handle = node ? findNodeHandle(node) : null;
        if (handle) AccessibilityInfo.setAccessibilityFocus(handle);
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [shown]);

  useEffect(() => {
    if (!shown) return;
    if (Platform.OS === 'web') {
      const onKey = (event: KeyboardEvent) => {
        if (event.key === 'Escape') onDone();
      };
      window_addKeydown(onKey);
      return () => window_removeKeydown(onKey);
    }
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onDone();
      return true;
    });
    return () => subscription.remove();
  }, [onDone, shown]);

  if (!target) return null;
  const layout = spotlightLayout(target, window, tipHeight, insets);
  const { cutout } = layout;
  const dims: TourRect[] = [
    { x: 0, y: 0, width: window.width, height: cutout.y },
    {
      x: 0,
      y: cutout.y + cutout.height,
      width: window.width,
      height: window.height - cutout.y - cutout.height,
    },
    { x: 0, y: cutout.y, width: cutout.x, height: cutout.height },
    {
      x: cutout.x + cutout.width,
      y: cutout.y,
      width: window.width - cutout.x - cutout.width,
      height: cutout.height,
    },
  ];
  const entering = reducedMotion ? undefined : FadeIn.duration(160);

  return (
    <Animated.View
      entering={entering}
      pointerEvents="box-none"
      style={styles.overlay}
      testID="tour-spotlight"
    >
      {dims.map((rect, index) => (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          key={index}
          style={[
            styles.dim,
            {
              left: rect.x,
              top: rect.y,
              width: Math.max(0, rect.width),
              height: Math.max(0, rect.height),
            },
          ]}
        />
      ))}
      <View
        pointerEvents="none"
        style={[
          styles.cutout,
          { left: cutout.x, top: cutout.y, width: cutout.width, height: cutout.height },
        ]}
        testID="tour-cutout"
      />
      <View
        accessibilityLabel={`${copy.title} ${spoken}`}
        accessibilityLiveRegion="polite"
        accessibilityRole="alert"
        accessibilityViewIsModal
        focusable
        onLayout={(event) => setTipHeight(event.nativeEvent.layout.height)}
        ref={tipRef}
        style={[
          styles.tip,
          { left: layout.tip.left, top: layout.tip.top, width: layout.tip.width },
        ]}
        testID={`tour-tip-${tip}`}
        {...(Platform.OS === 'web' ? { tabIndex: -1 } : {})}
      >
        <Text style={styles.tipTitle}>{copy.title}</Text>
        <Text style={styles.tipBody}>{copy.body}</Text>
        {copy.bullets?.map((bullet) => (
          <View key={bullet} style={styles.tipBullet}>
            <Text style={styles.tipBody}>{'\u2022'}</Text>
            <Text style={[styles.tipBody, styles.tipBulletText]}>{bullet}</Text>
          </View>
        ))}
        {copy.closing ? <Text style={styles.tipBody}>{copy.closing}</Text> : null}
        <View style={styles.tipFooter}>
          <OnboardingButton label="Got it" onPress={onDone} testID="tour-tip-done" />
        </View>
      </View>
    </Animated.View>
  );
}

// `window` is shadowed by the dimensions above; reach the DOM through
// globalThis so the listener works on web and compiles everywhere.
function window_addKeydown(listener: (event: KeyboardEvent) => void) {
  (globalThis as unknown as { addEventListener?: typeof addEventListener }).addEventListener?.(
    'keydown',
    listener as EventListener,
  );
}
function window_removeKeydown(listener: (event: KeyboardEvent) => void) {
  (
    globalThis as unknown as { removeEventListener?: typeof removeEventListener }
  ).removeEventListener?.('keydown', listener as EventListener);
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    root: { flex: 1 },
    overlay: { ...StyleSheet.absoluteFillObject, zIndex: 50 },
    dim: { position: 'absolute', backgroundColor: hull.bgTerminal, opacity: 0.82 },
    cutout: {
      position: 'absolute',
      borderWidth: 1,
      borderColor: hull.accent,
      borderRadius: hull.radius,
    },
    tip: {
      position: 'absolute',
      padding: hull.space.md,
      gap: hull.space.sm,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: hull.borderStrong,
      backgroundColor: hull.bgRaised,
    },
    tipTitle: { ...Typography.default(), ...hull.type.bodyStrong, color: hull.textPrimary },
    tipBody: { ...Typography.default(), ...hull.type.meta, color: hull.textSecondary },
    tipBullet: { flexDirection: 'row', gap: hull.space.sm, paddingLeft: hull.space.xs },
    tipBulletText: { flex: 1, minWidth: 0 },
    tipFooter: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      marginTop: hull.space.xs,
    },
  };
});
