let clock = 0;

/**
 * One clock orders every surface write and record change of this app. A
 * value read from a server after a stamp is newer than every change stamped
 * before it.
 */
export function nextSurfaceStamp(): number {
  clock += 1;
  return clock;
}

/** The current stamp: take it when a server read starts. */
export function currentSurfaceStamp(): number {
  return clock;
}
