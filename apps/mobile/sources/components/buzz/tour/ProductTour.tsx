import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  BackHandler,
  findNodeHandle,
  Platform,
  Pressable,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import {
  TOUR_TIP_IDS,
  finishProductTourOverview,
  loadProductTour,
  markTourTipSeen,
  replayProductTour,
  skipTourTips,
  subscribeProductTour,
  tourTipDue,
  tourTipPosition,
  type ProductTourState,
  type TourTipId,
} from '@/buzz/product-tour';
import { hasArea, spotlightLayout, type TourRect } from '@/buzz/tour-geometry';
import { ProductTourContext, type ProductTourContextValue, type TargetEntry } from './TourTarget';
import { Typography } from '@/constants/Typography';
import { HullFloatingSurface, HullModal } from '@/components/buzz/HullDialog';
import { PixelGateReveal } from '@/components/buzz/MonoHull';
import { RoomGlyph } from '@/components/buzz/RoomGlyph';
import { MembersGlyph } from '@/components/buzz/MembersGlyph';
import { CornerGlyph } from '@/components/buzz/CornerGlyph';
import { Ionicons } from '@expo/vector-icons';

/**
 * Beeline's product tour: a deliberately small sequencer on components the
 * app already ships (captain-delegated pick after every off-the-shelf tour
 * engine failed the Expo 55 / Fabric / web spike — see the PR).
 *
 * - The four overview cards float in `HullModal`, the app's one sanctioned
 *   RN `Modal`, so the tour adds no second modal layer. Escape and Android
 *   back close them like any Hull sheet; Skip sits on every card.
 * - First-sight spotlights are an in-tree overlay drawn after the app's own
 *   content and beneath any sheet: a Hull sheet opened while a tip shows
 *   stacks above it, never under it. A tip appears only once its real target
 *   has mounted and measured to a non-zero rect, one at a time, and hides the
 *   moment that target unmounts (it stays due for the next encounter).
 * - Escape (web) and back (Android) dismiss a tip; screen-reader focus moves
 *   to it; every control is at least 44pt; reduced motion drops the fades.
 */

export const TOUR_OVERVIEW_CARDS = [
  {
    art: 'room',
    title: 'Rooms hold the conversation.',
    body: 'Keep a team, project, or topic together. Bring in only the people and agents who belong.',
  },
  {
    art: 'people',
    title: 'Ask an agent by name.',
    body: 'Tag an agent with @ in a Room. It answers there, and you can stop its turn at any time.',
  },
  {
    art: 'corner',
    title: 'Corners bound the work.',
    body: 'For a focused task an agent opens a corner: its own context and a reviewable result.',
  },
  {
    art: 'workbench',
    title: 'Workbench equips your agents.',
    body: 'Tools and keys live in Settings → Workbench. Access still follows Workspace and grant boundaries.',
  },
] as const;

export const TOUR_TIP_COPY: Record<TourTipId, { title: string; body: string }> = {
  rooms: {
    title: 'Rooms keep context together.',
    body: 'Create one for a team, project, or topic. Membership decides who can read and act.',
  },
  corner: {
    title: 'A corner bounds the work.',
    body: 'Use it when an agent needs a focused task, its own context, and a reviewable result.',
  },
  workbench: {
    title: 'Workbench equips your agents.',
    body: 'Add tools and keys here. Access still follows Workspace and grant boundaries.',
  },
};

export function ProductTourProvider({ children }: { children: React.ReactNode }) {
  const [viewer, setViewer] = useState<string | null>(null);
  const [state, setState] = useState<ProductTourState | null>(null);
  const [roomSeen, setRoomSeen] = useState(false);
  const [layoutTick, setLayoutTick] = useState(0);
  const targets = useRef(new Map<TourTipId, TargetEntry>());
  const [targetIds, setTargetIds] = useState<readonly TourTipId[]>([]);

  // The viewer is re-read whenever a surface asks for the tour, so a sign-in
  // or identity change is picked up without any extra wiring.
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
      targets.current.set(tip, entry);
      setTargetIds([...targets.current.keys()]);
      refreshViewer();
      return () => {
        if (targets.current.get(tip) === entry) targets.current.delete(tip);
        setTargetIds([...targets.current.keys()]);
      };
    },
    [refreshViewer],
  );

  const context = useMemo<ProductTourContextValue>(
    () => ({
      registerTarget,
      targetLaidOut: () => setLayoutTick((tick) => tick + 1),
      roomReady: () => {
        refreshViewer();
        setRoomSeen(true);
      },
      replay: async (pubkey: string) => {
        setViewer(pubkey);
        setState(await replayProductTour(pubkey));
        setRoomSeen(true);
      },
    }),
    [refreshViewer, registerTarget],
  );

  const overviewOpen = Boolean(viewer && roomSeen && state?.overview === 'pending');
  const activeTip =
    viewer && state && !overviewOpen
      ? (TOUR_TIP_IDS.find((tip) => targetIds.includes(tip) && tourTipDue(state, tip)) ?? null)
      : null;

  return (
    <ProductTourContext.Provider value={context}>
      <View style={styles.root}>
        {children}
        {activeTip && viewer ? (
          <TourSpotlight
            key={activeTip}
            layoutTick={layoutTick}
            measure={() => targets.current.get(activeTip)?.measure() ?? Promise.resolve(null)}
            onDone={() => void markTourTipSeen(viewer, activeTip)}
            onSkipAll={() => void skipTourTips(viewer)}
            tip={activeTip}
          />
        ) : null}
      </View>
      <TourOverviewCards
        onFinish={(outcome) => viewer && void finishProductTourOverview(viewer, outcome)}
        visible={overviewOpen}
      />
    </ProductTourContext.Provider>
  );
}

function TourSpotlight({
  tip,
  measure,
  layoutTick,
  onDone,
  onSkipAll,
}: {
  tip: TourTipId;
  measure: () => Promise<TourRect | null>;
  layoutTick: number;
  onDone: () => void;
  onSkipAll: () => void;
}) {
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const [target, setTarget] = useState<TourRect | null>(null);
  const [tipHeight, setTipHeight] = useState(160);
  const tipRef = useRef<View>(null);
  const measureRef = useRef(measure);
  measureRef.current = measure;
  const copy = TOUR_TIP_COPY[tip];
  const position = tourTipPosition(tip);
  const last = position.index === position.total;

  // Re-measure on every target layout and window resize; an unmeasurable
  // target (unmounted, zero-sized, off screen) shows nothing at all.
  useEffect(() => {
    let live = true;
    void measureRef.current().then((rect) => {
      if (!live) return;
      const visible =
        hasArea(rect) &&
        rect.y + rect.height > 0 &&
        rect.y < window.height &&
        rect.x + rect.width > 0 &&
        rect.x < window.width;
      setTarget((current) =>
        !visible
          ? null
          : current &&
              current.x === rect.x &&
              current.y === rect.y &&
              current.width === rect.width &&
              current.height === rect.height
            ? current
            : rect,
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
        accessibilityLabel={`${copy.title} ${copy.body}`}
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
        <View style={styles.tipFooter}>
          <Text style={styles.tipCount}>{`${position.index} / ${position.total}`}</Text>
          {!last ? (
            <Pressable
              accessibilityRole="button"
              onPress={onSkipAll}
              style={styles.quietButton}
              testID="tour-tip-skip"
            >
              <Text style={styles.quietButtonText}>Skip tips</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            onPress={onDone}
            style={styles.primaryButton}
            testID="tour-tip-done"
          >
            <Text style={styles.primaryButtonText}>{last ? 'Finish' : 'Got it'}</Text>
          </Pressable>
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

function CardArt({ art }: { art: (typeof TOUR_OVERVIEW_CARDS)[number]['art'] }) {
  const { theme } = useUnistyles();
  const color = theme.buzz.accent;
  if (art === 'room') return <RoomGlyph color={color} size={40} />;
  if (art === 'people') return <MembersGlyph color={color} size={40} />;
  if (art === 'corner') return <CornerGlyph color={color} size={40} />;
  return <Ionicons color={color} name="construct-outline" size={40} />;
}

export function TourOverviewCards({
  visible,
  onFinish,
}: {
  visible: boolean;
  onFinish: (outcome: 'completed' | 'skipped') => void;
}) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (visible) setIndex(0);
  }, [visible]);
  const card = TOUR_OVERVIEW_CARDS[index]!;
  const last = index === TOUR_OVERVIEW_CARDS.length - 1;
  const skip = () => onFinish('skipped');
  return (
    <HullModal
      accessibilityLabel="Skip tour"
      onRequestClose={skip}
      placement="center"
      testID="tour-overview"
      visible={visible}
    >
      <HullFloatingSurface style={styles.card}>
        <PixelGateReveal key={index} style={styles.cardBody}>
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={styles.art}
          >
            <CardArt art={card.art} />
          </View>
          <Text accessibilityRole="header" style={styles.cardTitle} testID="tour-card-title">
            {card.title}
          </Text>
          <Text style={styles.cardText}>{card.body}</Text>
        </PixelGateReveal>
        <View style={styles.cardFooter}>
          <View
            accessibilityLabel={`Card ${index + 1} of ${TOUR_OVERVIEW_CARDS.length}`}
            accessible
            style={styles.pager}
          >
            {TOUR_OVERVIEW_CARDS.map((entry, dot) => (
              <View
                key={entry.title}
                style={[styles.pagerDot, dot === index && styles.pagerDotOn]}
              />
            ))}
          </View>
          <Pressable
            accessibilityRole="button"
            onPress={skip}
            style={styles.quietButton}
            testID="tour-skip"
          >
            <Text style={styles.quietButtonText}>Skip tour</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => (last ? onFinish('completed') : setIndex(index + 1))}
            style={styles.primaryButton}
            testID="tour-next"
          >
            <Text style={styles.primaryButtonText}>{last ? 'Start' : 'Next'}</Text>
          </Pressable>
        </View>
      </HullFloatingSurface>
    </HullModal>
  );
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
    tipFooter: { flexDirection: 'row', alignItems: 'center', gap: hull.space.sm },
    tipCount: { ...Typography.mono(), ...hull.type.machine, color: hull.ledgerQuiet, flex: 1 },
    quietButton: {
      minHeight: 44,
      minWidth: 44,
      paddingHorizontal: hull.space.sm,
      alignItems: 'center',
      justifyContent: 'center',
    },
    quietButtonText: { ...Typography.default(), ...hull.type.meta, color: hull.ledgerQuiet },
    primaryButton: {
      minHeight: 44,
      minWidth: 44,
      paddingHorizontal: hull.space.md,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: hull.radius,
      backgroundColor: hull.accent,
    },
    primaryButtonText: {
      ...Typography.default(),
      ...hull.type.bodyStrong,
      color: hull.textInverted,
    },
    card: {
      width: '100%',
      maxWidth: 420,
      borderRadius: 10,
      padding: hull.space.lg,
      gap: hull.space.lg,
    },
    cardBody: { gap: hull.space.sm },
    art: {
      height: 96,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: hull.space.sm,
      borderRadius: hull.radius,
      borderWidth: 1,
      borderColor: hull.border,
      backgroundColor: hull.bgBase,
    },
    cardTitle: { ...Typography.default(), ...hull.type.hero, color: hull.textPrimary },
    cardText: { ...Typography.default(), ...hull.type.body, color: hull.textSecondary },
    cardFooter: { flexDirection: 'row', alignItems: 'center', gap: hull.space.sm },
    pager: { flexDirection: 'row', gap: hull.space.xs, flex: 1 },
    pagerDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      borderWidth: 1,
      borderColor: hull.ledgerGhost,
    },
    pagerDotOn: { backgroundColor: hull.accent, borderColor: hull.accent },
  };
});
