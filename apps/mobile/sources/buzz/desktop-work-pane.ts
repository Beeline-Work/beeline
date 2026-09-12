export type DesktopWorkPaneSelection = {
  roomId: string;
  cornerId: string;
};

const listeners = new Set<(selection: DesktopWorkPaneSelection) => void>();

/**
 * The desktop navigator and Room route are siblings in Expo's permanent drawer.
 * A tiny browser event keeps corner selection presentation-only: the URL stays
 * on the Room, the middle pane keeps talking, and the right pane opens work.
 */
export function selectDesktopWorkCorner(selection: DesktopWorkPaneSelection): void {
  for (const listener of listeners) listener(selection);
}

export function subscribeDesktopWorkCorner(
  listener: (selection: DesktopWorkPaneSelection) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
