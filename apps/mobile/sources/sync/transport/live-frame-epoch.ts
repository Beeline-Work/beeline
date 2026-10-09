let frames = 0;

/** The live socket delivered one more frame. */
export function noteLiveFrame(): void {
  frames += 1;
}

/**
 * How many frames the live socket has delivered. A read started before a
 * frame may predate the change that frame announced, so a later identical
 * read must not share it (`room-view-client.ts`).
 */
export function liveFrameEpoch(): number {
  return frames;
}
