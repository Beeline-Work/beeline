/** Derive one transition window from the unchanged release sampler. */
export function transitionMetrics(sample, native, clockOffsetMs, cpu) {
  const intervals = sample.jsFrameIntervalsMs;
  if (!intervals.length || intervals.some(x => !Number.isFinite(x) || x <= 0)) throw new Error('Missing frame intervals');
  const residual = sample.endMs - sample.startMs - intervals.reduce((a, b) => a + b, 0);
  // The old sampler omits its first rAF timestamp. Its position is bounded by
  // the unsampled first and final fractions, not invented as an exact timestamp.
  if (residual < -1 || residual > 50) throw new Error(`First-frame alignment uncertainty too large: ${residual}`);
  const tap = native.startMs - clockOffsetMs;
  const paint = native.paintMs - clockOffsetMs;
  const run = shift => {
    let cursor = sample.startMs + shift, quiet = paint, worst = 0;
    const gaps = [];
    for (const duration of intervals) {
      gaps.push({ start: cursor, end: cursor + duration, duration });
      cursor += duration;
    }
    for (const gap of gaps) {
      if (gap.end < tap) continue;
      if (gap.start > quiet + 500) break;
      worst = Math.max(worst, gap.duration);
      if (gap.duration > 50 && gap.end >= paint) quiet = Math.max(quiet, gap.end);
    }
    const settled = quiet + 500;
    if (tap < sample.startMs || settled > cursor) throw new Error('Transition escaped the frame sampling window');
    return { settledEpochMs: settled + clockOffsetMs, timeToSettledMs: settled - tap, worstJsGapMs: worst };
  };
  const bounds = [run(0), run(Math.max(0, residual))];
  const mid = run(Math.max(0, residual) / 2);
  const previous = t => [...cpu].reverse().find(row => row.epochMs <= t);
  const next = t => cpu.find(row => row.epochMs >= t);
  const startBefore = previous(native.startMs), startAfter = next(native.startMs);
  const endBefore = previous(mid.settledEpochMs), endAfter = next(mid.settledEpochMs);
  const earliestEnd = previous(Math.min(...bounds.map(x => x.settledEpochMs)));
  const latestEnd = next(Math.max(...bounds.map(x => x.settledEpochMs)));
  if (!startBefore || !startAfter || !endBefore || !endAfter || !earliestEnd || !latestEnd) throw new Error('CPU samples do not cover the transition');
  const interpolate = (a, b, t) => a.runtimeNs + (b.runtimeNs - a.runtimeNs) * (t - a.epochMs) / Math.max(1, b.epochMs - a.epochMs);
  return { ...mid, firstFrameAlignmentUncertaintyMs: Math.max(0, residual),
    timeToSettledBoundsMs: bounds.map(x => x.timeToSettledMs).sort((a,b)=>a-b),
    jsBusyCpuMs: (interpolate(endBefore, endAfter, mid.settledEpochMs) - interpolate(startBefore, startAfter, native.startMs)) / 1e6,
    jsBusyCpuBoundsMs: [(earliestEnd.runtimeNs - startAfter.runtimeNs) / 1e6, (latestEnd.runtimeNs - startBefore.runtimeNs) / 1e6],
    cpuBoundaryPollSpanMs: Math.max(startAfter.epochMs-startBefore.epochMs, endAfter.epochMs-endBefore.epochMs),
  };
}
