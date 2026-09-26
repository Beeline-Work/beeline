import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { NavigationContext } from '@react-navigation/core';
import type { TourTipId } from '@/buzz/product-tour';
import type { TourRect } from '@/buzz/tour-geometry';

/**
 * The lightweight half of the product tour: what a screen needs to mark a
 * spotlight target or cue the overview, with no drawing code, so any screen
 * can import it. The drawing half is `ProductTour.tsx`.
 */
export type TargetEntry = { measure: () => Promise<TourRect | null> };

export type ProductTourContextValue = {
  registerTarget: (tip: TourTipId, entry: TargetEntry) => () => void;
  targetLaidOut: (tip: TourTipId) => void;
  roomReady: () => void;
  replay: (pubkey: string) => Promise<void>;
};

export const ProductTourContext = createContext<ProductTourContextValue | null>(null);

export function measureView(view: View | null): Promise<TourRect | null> {
  return new Promise((resolve) => {
    if (!view || typeof view.measureInWindow !== 'function') return resolve(null);
    view.measureInWindow((x, y, width, height) => resolve({ x, y, width, height }));
  });
}

/**
 * Marks the element a first-sight spotlight points at. It registers only
 * while mounted and re-measures on every layout, so a tip never points at a
 * stale rect and never waits on a target that is gone.
 */
export function TourTarget({
  tip,
  children,
  style,
}: {
  tip: TourTipId;
  children: React.ReactNode;
  style?: React.ComponentProps<typeof View>['style'];
}) {
  const tour = useContext(ProductTourContext);
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
  useEffect(() => {
    if (!tour || !focused) return;
    return tour.registerTarget(tip, { measure: () => measureView(ref.current) });
  }, [focused, tip, tour]);
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
      {children}
    </View>
  );
}

/** A `TourTarget` only where the caller says so (e.g. the first row). */
export function MaybeTourTarget({
  enabled,
  tip,
  children,
}: {
  enabled: boolean;
  tip: TourTipId;
  children: React.ReactNode;
}) {
  return enabled ? <TourTarget tip={tip}>{children}</TourTarget> : <>{children}</>;
}

/** Settings → Replay product tour: both layers again, starting now. */
export function useReplayProductTour(): ((pubkey: string) => Promise<void>) | null {
  return useContext(ProductTourContext)?.replay ?? null;
}

/** Tells the tour the first useful Room has rendered: offer the overview now. */
export function ProductTourRoomCue({ ready }: { ready: boolean }) {
  const tour = useContext(ProductTourContext);
  useEffect(() => {
    if (ready) tour?.roomReady();
  }, [ready, tour]);
  return null;
}
