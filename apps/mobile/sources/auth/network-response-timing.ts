export type NetworkResponseTiming = {
  requestStartMs: number;
  responseReceivedMs: number;
  responseCompletedMs: number;
  jsHandledMs: number;
};

/** Native resource entries retain arrival time while the JS thread is busy.
 * Older store binaries without this API omit network timing rather than
 * reporting their delayed JS callback as a network measurement. */
export function beginNetworkResponseTiming(url: string): () => NetworkResponseTiming | null {
  const startedAt = performance.now();
  if (typeof PerformanceObserver === 'undefined' ||
      !PerformanceObserver.supportedEntryTypes?.includes('resource')) return () => null;
  const entries: PerformanceResourceTiming[] = [];
  let observer: PerformanceObserver;
  try {
    observer = new PerformanceObserver(list => {
      entries.push(...list.getEntries() as PerformanceResourceTiming[]);
    });
    observer.observe({ type: 'resource' });
  } catch { return () => null; }
  return () => {
    const jsHandledMs = performance.now();
    try {
      entries.push(...observer.takeRecords() as PerformanceResourceTiming[]);
    } catch { return null; }
    finally { observer.disconnect(); }
    const matches = entries.filter(entry => entry.name === url &&
      entry.fetchStart >= startedAt && entry.responseEnd <= jsHandledMs &&
      entry.responseStart >= entry.fetchStart && entry.responseEnd >= entry.responseStart);
    if (matches.length !== 1) return null;
    const entry = matches[0]!;
    return {
      requestStartMs: entry.fetchStart,
      responseReceivedMs: entry.responseStart,
      responseCompletedMs: entry.responseEnd,
      jsHandledMs,
    };
  };
}
