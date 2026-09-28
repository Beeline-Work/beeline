import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Platform, View, type LayoutChangeEvent } from 'react-native';
import { NavigationContext } from '@react-navigation/core';
import type { TourTipId } from '@/buzz/product-tour';
import type { TourRect } from '@/buzz/tour-geometry';

/**
 * The lightweight half of the tips: what a screen needs to mark a tip's
 * target, with no drawing code, so any screen can import it. The drawing
 * half is `ProductTour.tsx`.
 */
export type TargetEntry = { measure: () => Promise<TourRect | null> };

export type ProductTourContextValue = {
  registerTarget: (tip: TourTipId, entry: TargetEntry) => () => void;
  targetLaidOut: (tip: TourTipId) => void;
  replay: (pubkey: string) => Promise<void>;
};

export const ProductTourContext = createContext<ProductTourContextValue | null>(null);
/** The target the tip on screen points at, so that one target can pose for it. */
export const ActiveTourTargetContext = createContext<TargetEntry | null>(null);
/** Tips already retired; their targets stop registering. Null until the state is read. */
export const SeenTourTipsContext = createContext<readonly TourTipId[] | null>(null);

export function measureView(view: View | null): Promise<TourRect | null> {
  return new Promise((resolve) => {
    // react-native-web's measureInWindow walks offsets and ignores transforms,
    // so a row inside an inverted (flipped) list measures upside down; the
    // DOM's own rect is exact.
    const dom = view as unknown as { getBoundingClientRect?: () => DOMRect } | null;
    if (Platform.OS === 'web' && typeof dom?.getBoundingClientRect === 'function') {
      const rect = dom.getBoundingClientRect();
      return resolve({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
    }
    if (!view || typeof view.measureInWindow !== 'function') return resolve(null);
    view.measureInWindow((x, y, width, height) => resolve({ x, y, width, height }));
  });
}

/**
 * Marks the element a first-sight tip points at. It registers only
 * while mounted and re-measures on every layout, so a tip never points at a
 * stale rect and never waits on a target that is gone.
 */
export function TourTarget({
  tip,
  children,
  style,
}: {
  tip: TourTipId;
  /** A render function learns whether the tip on screen points at this target. */
  children: React.ReactNode | ((active: boolean) => React.ReactNode);
  style?: React.ComponentProps<typeof View>['style'];
}) {
  const tour = useContext(ProductTourContext);
  const seen = useContext(SeenTourTipsContext);
  const activeEntry = useContext(ActiveTourTargetContext);
  // A retired tip costs nothing: many rows may carry the same target (every
  // message someone else wrote), and none of them registers once it is seen.
  const due = !seen?.includes(tip);
  // A screen kept mounted under the navigation stack is not "first sight":
  // only a focused screen's target may be pointed at. Persistent chrome with
  // no screen of its own (the desktop sidebar) is always in sight.
  const navigation = useContext(NavigationContext);
  const [focused, setFocused] = useState(() => navigation?.isFocused() ?? true);
  useEffect(() => {
    if (!navigation) return;
    setFocused(navigation.isFocused());
    const offFocus = navigation.addListener('focus', () => setFocused(true));
    const offBlur = navigation.addListener('blur', () => setFocused(false));
    return () => {
      offFocus();
      offBlur();
    };
  }, [navigation]);
  const ref = useRef<View>(null);
  const entry = useRef<TargetEntry>({ measure: () => measureView(ref.current) }).current;
  useEffect(() => {
    if (!tour || !focused || !due) return;
    return tour.registerTarget(tip, entry);
  }, [due, entry, focused, tip, tour]);
  const onLayout = useCallback(
    (_event: LayoutChangeEvent) => {
      tour?.targetLaidOut(tip);
    },
    [tip, tour],
  );
  return (
    <View
      collapsable={false}
      onLayout={onLayout}
      ref={ref}
      style={style}
      testID={`tour-target-${tip}`}
    >
      {typeof children === 'function' ? children(activeEntry === entry) : children}
    </View>
  );
}

/** Settings → Replay tips: all three are due again, starting now. */
export function useReplayProductTour(): ((pubkey: string) => Promise<void>) | null {
  return useContext(ProductTourContext)?.replay ?? null;
}
