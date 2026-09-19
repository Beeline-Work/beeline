/**
 * Cold start is OS splash, then one BootPaint, then the Room deck. The deck's
 * own page loader must not paint the mark again on that first mount.
 */
let firstRoomDeckAfterBoot = true;

export function consumeFirstRoomDeckAfterBoot(): boolean {
  const first = firstRoomDeckAfterBoot;
  firstRoomDeckAfterBoot = false;
  return first;
}
