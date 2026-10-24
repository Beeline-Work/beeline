import { useLayoutEffect, useRef } from 'react';

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
// Diagnostic builds only: identify the exact prop that crossed a memo boundary.
export function useMeasuredPropCommit(kind, id, readProps) {
  useMeasuredCommit(kind, id);
  const previous = useRef(null);
  useLayoutEffect(() => {
    const props = readProps();
    const entry = sample?.commits.at(-1);
    if (entry?.kind === kind && entry.id === id)
      entry.propsChanged = Object.keys(props).filter(key => !previous.current || !Object.is(previous.current[key], props[key]));
    previous.current = props;
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
    const result = { ...sample, endMs: performance.now(), build: globalThis.__transcriptBuild,
      runtime: { hermes: !!globalThis.HermesInternal, fabric: !!globalThis.nativeFabricUIManager } };
    sample = null;
    return result;
  },
};

// Explicit fixture build only. Polling stops for the complete measurement
// window; the start acknowledgement and result upload are outside it.
const control = process.env.EXPO_PUBLIC_TRANSCRIPT_CONTROL;
if (control && /^http:\/\/(127\.0\.0\.1|10\.0\.2\.2):19886$/.test(control)) {
  const post = (path, value) => fetch(`${control}/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  });
  const loop = async () => {
    try {
      const command = await (await fetch(`${control}/next`)).json();
      if (command && typeof command.id === 'string' && typeof command.name === 'string' &&
          command.durationMs >= 500 && command.durationMs <= 60000) {
        await post('started', { id: command.id });
        const enabled = command.enabled !== false;
        const startMs = performance.now();
        if (enabled) globalThis.__transcriptSpeed.begin(command.name);
        await new Promise(resolve => setTimeout(resolve, command.durationMs));
        const result = enabled ? globalThis.__transcriptSpeed.end()
          : { name: command.name, startMs, endMs: performance.now(), commits: [], jsFrameIntervalsMs: [], build: globalThis.__transcriptBuild };
        result.samplingEnabled = enabled;
        await post('result', { id: command.id, sample: result });
      }
    } catch { /* The fixture driver may not be running yet. */ }
    setTimeout(loop, 500);
  };
  setTimeout(loop, 500);
}
