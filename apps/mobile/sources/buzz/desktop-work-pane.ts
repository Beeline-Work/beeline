export type DesktopWorkPaneSelection = {
  roomId: string;
  cornerId: string;
};

const listeners = new Set<(selection: DesktopWorkPaneSelection) => boolean | void>();
let pendingSelection: DesktopWorkPaneSelection | null = null;

export function subscribeDesktopWorkCorner(
  listener: (selection: DesktopWorkPaneSelection) => boolean | void,
): () => void {
  listeners.add(listener);
  if (pendingSelection && listener(pendingSelection)) pendingSelection = null;
  return () => listeners.delete(listener);
}
