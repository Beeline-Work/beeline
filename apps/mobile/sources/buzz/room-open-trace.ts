/** One tap-to-pixel trace for Room open. Metro/logcat drop `console.log`.
 *  Release product must not emit it: `__DEV__` is false in production bundles. */

export function markRoomOpen(phase: string, detail?: string): void {
  if (typeof __DEV__ !== 'undefined' && !__DEV__) return;
  if (
    typeof process !== 'undefined' &&
    (process.env.NODE_ENV === 'test' || process.env.VITEST)
  ) {
    return;
  }
  console.warn(
    `[ROOM_OPEN] ${JSON.stringify({ phase, t: performance.now(), ...(detail ? { detail } : {}) })}`,
  );
}
