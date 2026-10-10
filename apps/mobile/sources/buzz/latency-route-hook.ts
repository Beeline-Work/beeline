/** A content-ready frame hook kept separate from the pure marker/logging module. */
import * as React from 'react';
import { useIsFocused } from '@react-navigation/native';
import { latencyFrameTraceEnabled, markLatencyRouteFrame } from './latency-frame-trace';

function useLatencyRouteFrameEnabled(route: string, ready = true, meaningful = false): void {
  const focused = useIsFocused();
  React.useEffect(() => {
    if (!focused || !ready) return;
    markLatencyRouteFrame(route, meaningful ? 'meaningful-frame' : 'frame-candidate');
  }, [focused, meaningful, ready, route]);
}

// The selected implementation is fixed at bundle evaluation. Ordinary release
// screens install no focus listeners or effects for the rig.
export const useLatencyRouteFrame: (route: string, ready?: boolean, meaningful?: boolean) => void =
  latencyFrameTraceEnabled ? useLatencyRouteFrameEnabled : () => undefined;
