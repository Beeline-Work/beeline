export type DesktopWorkPaneSelection = {
  roomId: string;
  cornerId: string;
};

const listeners = new Set<(selection: DesktopWorkPaneSelection) => boolean | void>();
let pendingSelection: DesktopWorkPaneSelection | null = null;

/**
 * The desktop navigator and Room route are siblings in Expo's permanent drawer.
 * A tiny browser event keeps corner selection presentation-only: the URL stays
 * on the Room, the middle pane keeps talking, and the second pane shows the
 * corner. A selection for another Room waits until that Room is in view.
 */
export function selectDesktopWorkCorner(selection: DesktopWorkPaneSelection): void {
  pendingSelection = selection;
  for (const listener of listeners) {
    if (listener(selection)) pendingSelection = null;
  }
}

export function subscribeDesktopWorkCorner(
  listener: (selection: DesktopWorkPaneSelection) => boolean | void,
): () => void {
  listeners.add(listener);
  if (pendingSelection && listener(pendingSelection)) pendingSelection = null;
  return () => listeners.delete(listener);
}
