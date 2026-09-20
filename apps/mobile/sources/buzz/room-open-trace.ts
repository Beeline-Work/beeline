/**
 * One tap-to-pixel trace for Room open.
 *
 * This used to be development-only, which meant the one build that could
 * answer "why is this Room slow on my phone" was the one build that never
 * ran on a phone. The trace now also emits from a release bundle when
 * EXPO_PUBLIC_ROOM_OPEN_TRACE is set to "1" at build time, so a real device
 * on a real network against production can be read instead of guessed at.
 *
 * Default is still silent: an unset flag in a release bundle emits nothing,
 * exactly as before.
 */

/** Build-time opt-in. Expo inlines EXPO_PUBLIC_* at bundle time. */
const RELEASE_TRACE_ENABLED =
  typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_ROOM_OPEN_TRACE === '1';

function tracingOff(): boolean {
  if (
    typeof process !== 'undefined' &&
    (process.env.NODE_ENV === 'test' || process.env.VITEST)
  ) {
    return true;
  }
  const isDev = typeof __DEV__ !== 'undefined' && __DEV__;
  return !isDev && !RELEASE_TRACE_ENABLED;
}

type TraceMark = { phase: string; t: number; detail?: string };

/** The current open, oldest mark first. Reset when a Room open begins. */
let currentRun: TraceMark[] = [];
let listeners: Array<(run: readonly TraceMark[]) => void> = [];

/** The first mark of an open. Everything after it belongs to the same run. */
const RUN_START_PHASE = 'nav-dispatch';

function publish(): void {
  const snapshot = currentRun.slice();
  for (const listener of listeners) listener(snapshot);
}

/** Subscribe to the running trace. Returns an unsubscribe. */
export function observeRoomOpenTrace(
  listener: (run: readonly TraceMark[]) => void,
): () => void {
  listeners.push(listener);
  listener(currentRun.slice());
  return () => {
    listeners = listeners.filter((entry) => entry !== listener);
  };
}

/** True when this build was asked to report timings on screen. */
export function roomOpenTraceEnabled(): boolean {
  return !tracingOff();
}

export function markRoomOpen(phase: string, detail?: string): void {
  if (tracingOff()) return;
  const mark: TraceMark = { phase, t: performance.now(), ...(detail ? { detail } : {}) };
  if (phase === RUN_START_PHASE || currentRun.length === 0) currentRun = [mark];
  else currentRun.push(mark);
  publish();
  console.warn(`[ROOM_OPEN] ${JSON.stringify(mark)}`);
}

/**
 * The run as elapsed milliseconds from the first mark, which is what a reader
 * needs. Absolute timestamps say nothing without subtraction.
 */
export function roomOpenElapsed(
  run: readonly TraceMark[],
): Array<{ phase: string; ms: number; detail?: string }> {
  const first = run[0];
  if (!first) return [];
  return run.map((mark) => ({
    phase: mark.phase,
    ms: Math.round(mark.t - first.t),
    ...(mark.detail ? { detail: mark.detail } : {}),
  }));
}

/**
 * What the Room read actually carried, beside how long it took.
 *
 * A phase timing says the read was slow; it cannot say whether the weight was
 * messages, tool output, the member roster or the corner family. The message
 * window is already bounded at 30, so when a busy Room opens slower than a
 * quiet one the difference is in one of the other three, and this is the line
 * that names which.
 */
export function markRoomOpenWeight(view: {
  messages?: readonly unknown[];
  toolRows?: readonly unknown[];
  members?: readonly unknown[];
  corners?: readonly unknown[];
}): void {
  if (tracingOff()) return;
  let bytes: number | undefined;
  try {
    bytes = JSON.stringify(view).length;
  } catch {
    bytes = undefined;
  }
  const mark = {
      phase: 'room-read-weight',
      t: performance.now(),
      messages: view.messages?.length ?? 0,
      toolRows: view.toolRows?.length ?? 0,
      members: view.members?.length ?? 0,
      corners: view.corners?.length ?? 0,
      ...(bytes === undefined ? {} : { bytes }),
  };
  currentRun.push({
    phase: `read: ${mark.messages}m ${mark.toolRows}t ${mark.members}p ${mark.corners}c${
      bytes === undefined ? '' : ` ${Math.round(bytes / 1024)}kB`
    }`,
    t: mark.t,
  });
  publish();
  console.warn(`[ROOM_OPEN] ${JSON.stringify(mark)}`);
}
