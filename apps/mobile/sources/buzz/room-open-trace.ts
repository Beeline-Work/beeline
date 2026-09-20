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

export function markRoomOpen(phase: string, detail?: string): void {
  if (tracingOff()) return;
  console.warn(
    `[ROOM_OPEN] ${JSON.stringify({ phase, t: performance.now(), ...(detail ? { detail } : {}) })}`,
  );
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
  console.warn(
    `[ROOM_OPEN] ${JSON.stringify({
      phase: 'room-read-weight',
      t: performance.now(),
      messages: view.messages?.length ?? 0,
      toolRows: view.toolRows?.length ?? 0,
      members: view.members?.length ?? 0,
      corners: view.corners?.length ?? 0,
      ...(bytes === undefined ? {} : { bytes }),
    })}`,
  );
}
