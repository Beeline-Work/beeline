export type DesktopSessionState = 'checking' | 'signed-in' | 'signed-out';

/** The frame and its Room deck must use the same live width class, including
 *  native desktop windows. Otherwise a compact deck renders beside a permanent
 *  sidebar and both Room lists compete for the narrow window. */
export function usesPersistentDesktopFrame(
  _inDesktopShell: boolean,
  tabletLayout: boolean,
): boolean {
  return tabletLayout;
}

/** Native desktop chrome is session-owned. A signed-out window is one auth task. */
export function showsDesktopSessionChrome(
  inDesktopShell: boolean,
  tabletLayout: boolean,
  session: DesktopSessionState,
): boolean {
  if (!tabletLayout) return false;
  if (!inDesktopShell) return true;
  return session === 'signed-in';
}
