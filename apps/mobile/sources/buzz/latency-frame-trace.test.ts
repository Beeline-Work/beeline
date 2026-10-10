import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it('notifies held route probes on each pathname commit, including a revisit', async () => {
  vi.stubEnv('EXPO_PUBLIC_LATENCY_RIG_TRACE', '1');
  vi.resetModules();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const trace = await import('./latency-frame-trace');
  const seen: boolean[] = [];
  const unsubscribe = trace.subscribeLatencyRoute(() => {
    seen.push(trace.latencyRouteMatches('/beeline/chat/[channelId]'));
  });
  trace.markLatencyRouteNavigation('/beeline/chat/one');
  trace.markLatencyRouteNavigation('/beeline/channels');
  trace.markLatencyRouteNavigation('/beeline/chat/two');
  unsubscribe();
  trace.markLatencyRouteNavigation('/beeline/chat/three');
  expect(seen).toEqual([true, false, true]);
});
