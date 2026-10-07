/**
 * The native splash covers the app until its first launch step settles. No
 * single step may hold it up forever: font loading that rejects or never
 * settles, or a root render error that unmounts the layout before it can hide
 * the splash. The app tree is already mounted underneath, so hiding it shows a
 * usable screen, with system fonts at worst.
 */
export const SPLASH_WATCHDOG_MS = 4000;

export type LaunchSplash = {
  /** Hide the splash now; later calls and the deadline do nothing. */
  release(): void;
};

/** Arm once per JS runtime, before React renders, so no component lifetime can cancel it. */
export function armLaunchSplash(
  hide: () => void,
  options: { timeoutMs?: number; log?: (message: string) => void } = {},
): LaunchSplash {
  let hidden = false;
  const release = () => {
    if (hidden) return;
    hidden = true;
    clearTimeout(timer);
    hide();
  };
  const timer = setTimeout(() => {
    options.log?.('[LAUNCH] Splash watchdog hid the splash before launch settled');
    release();
  }, options.timeoutMs ?? SPLASH_WATCHDOG_MS);
  return { release };
}
