export type DesktopSessionState = 'checking' | 'signed-in' | 'signed-out';

/** A native desktop window keeps its desktop frame at every supported width.
 *  A browser must pass the live width class (`isTablet` / `useIsTablet`),
 *  never `isDesktopPlatform()` — that is true for every web session. */
export function usesPersistentDesktopFrame(
  inDesktopShell: boolean,
  tabletLayout: boolean,
): boolean {
  return inDesktopShell || tabletLayout;
}

/** Native desktop chrome is session-owned. A signed-out window is one auth task. */
export function showsDesktopSessionChrome(
  inDesktopShell: boolean,
  tabletLayout: boolean,
  session: DesktopSessionState,
): boolean {
  if (!inDesktopShell) return tabletLayout;
  return session === 'signed-in';
}
