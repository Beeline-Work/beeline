import { useLayoutEffect } from 'react';

// Imported only by the explicitly instrumented build. Store samples in memory;
// writing a log for every frame would distort the measurement.
let sample = null;
let frame = null;
let last = null;
const recordFrame = (now) => {
  if (!sample) return;
  if (last !== null) sample.jsFrameIntervalsMs.push(now - last);
  last = now;
  frame = requestAnimationFrame(recordFrame);
};
export function useMeasuredCommit(kind, id) {
  useLayoutEffect(() => {
    if (!sample) return;
    sample.commits.push({ kind, id, atMs: performance.now() });
  });
}
globalThis.__transcriptSpeed = {
  begin(name) {
    if (sample) throw new Error('Finish the current transcript measurement first');
    last = null;
    sample = { name, startMs: performance.now(), commits: [], jsFrameIntervalsMs: [] };
    frame = requestAnimationFrame(recordFrame);
  },
  end() {
    if (!sample) throw new Error('No transcript measurement running');
    cancelAnimationFrame(frame);
    const result = { ...sample, endMs: performance.now() };
    sample = null;
    return result;
  },
};
