/** One tap-to-pixel trace for Room open. Metro/logcat drop `console.log`. */

export function markRoomOpen(phase: string, detail?: string): void {
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
