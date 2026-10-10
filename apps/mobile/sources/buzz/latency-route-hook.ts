/** A content-ready frame hook kept separate from the pure marker/logging module. */
import * as React from 'react';
import {
  latencyFrameTraceEnabled, latencyRouteMatches, markLatencyRouteFrame,
  subscribeLatencyRoute,
} from './latency-frame-trace';

function useLatencyRouteFrameEnabled(route: string, ready = true, meaningful = false): void {
  React.useEffect(() => {
    if (!ready) return;
    const emit = () => {
      if (latencyRouteMatches(route))
        markLatencyRouteFrame(route, meaningful ? 'meaningful-frame' : 'frame-candidate');
    };
    const unsubscribe = subscribeLatencyRoute(emit);
    emit();
    return unsubscribe;
  }, [meaningful, ready, route]);
}

// The selected implementation is fixed at bundle evaluation. Ordinary release
// screens install no focus listeners or effects for the rig.
export const useLatencyRouteFrame: (route: string, ready?: boolean, meaningful?: boolean) => void =
  latencyFrameTraceEnabled ? useLatencyRouteFrameEnabled : () => undefined;
