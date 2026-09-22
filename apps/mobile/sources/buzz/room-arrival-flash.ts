/**
 * The pointer a reader gets when a push notification lands them on one row in
 * the middle of a transcript. Arrival was silent: the deep link worked, put
 * the row on screen, and left the reader to find it among its neighbours.
 *
 * It is a transient state on an existing row — a ground fill in `bgHighlight`,
 * the token that already means "this is the thing", already contrast-tested in
 * `groknight.test.ts`. No new token, no new colour, no stroke: the area is the
 * signal, which is what that token's own comment specifies.
 */

/** How long the fill sits at full strength before it starts to leave. */
export const ARRIVAL_FLASH_HOLD_MS = 1100;
/** How long it takes to leave, once. */
export const ARRIVAL_FLASH_FADE_MS = 550;

export type ArrivalFlashTiming = {
  holdMs: number;
  fadeMs: number;
  totalMs: number;
};

/**
 * One cycle, never a repeat. Under reduce-motion the fill still holds — the
 * reader is owed the pointer either way — and then clears outright instead of
 * fading. Degrading to no flash at all would take the pointer away from the
 * readers most likely to need it; degrading to a fade is the motion they
 * asked not to be shown.
 */
export function arrivalFlashTiming(reduceMotion: boolean): ArrivalFlashTiming {
  const fadeMs = reduceMotion ? 0 : ARRIVAL_FLASH_FADE_MS;
  return { holdMs: ARRIVAL_FLASH_HOLD_MS, fadeMs, totalMs: ARRIVAL_FLASH_HOLD_MS + fadeMs };
}

/**
 * Only the explicit jump flashes.
 *
 * A landing completes for two quite different reasons: the reader followed a
 * notification to one named message, or the Room simply opened on its unread
 * cursor. Flashing the second would put a highlight on every Room open, which
 * is wallpaper — and the NEW MESSAGES divider already says where the unread
 * run starts.
 */
export function landingFlashesArrival({
  landedBoundaryId,
  messageAnchorId,
}: {
  landedBoundaryId: string | null;
  /** The notification's target row (`notificationMessageId ?? notificationTarget`). */
  messageAnchorId: string | null;
}): boolean {
  return (
    landedBoundaryId !== null && messageAnchorId !== null && landedBoundaryId === messageAnchorId
  );
}
