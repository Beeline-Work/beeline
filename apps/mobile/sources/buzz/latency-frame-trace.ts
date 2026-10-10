/** Release-rig-only frame candidates. The capture harness verifies visible content. */
export const latencyFrameTraceEnabled =
  typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_LATENCY_RIG_TRACE === '1';

let touchSequence = 0;

function mark(payload: Record<string, string | number>): void {
  if (!latencyFrameTraceEnabled) return;
  console.warn(`[LATENCY_FRAME] ${JSON.stringify({ ...payload, t: performance.now() })}`);
}

/** A tap's raw frame sequence; a screenshot diff selects the first actual feedback. */
export function markLatencyTouch(): void {
  if (!latencyFrameTraceEnabled) return;
  const touch = ++touchSequence;
  mark({ kind: 'tap', phase: 'start', touch });
  const startedAt = performance.now();
  const frame = () => {
    mark({ kind: 'tap', phase: 'frame-candidate', touch });
    if (performance.now() - startedAt < 300) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** The pathname committed; a deep-link driver can pair this with its intent start. */
export function markLatencyRouteNavigation(route: string): void {
  mark({ kind: 'route', phase: 'navigation-commit', route });
}

/** Route-specific content code calls this only after its meaningful view commits. */
export function markLatencyRouteFrame(route: string, phase: 'meaningful-frame' | 'frame-candidate' = 'meaningful-frame'): void {
  if (!latencyFrameTraceEnabled) return;
  requestAnimationFrame(() => mark({ kind: 'route', phase, route }));
}
