export type DesktopWorkPaneSelection = {
  roomId: string;
  cornerId: string;
};

export const DESKTOP_CORNER_DRAG_TYPE = 'application/x-beeline-corner';

const listeners = new Set<(selection: DesktopWorkPaneSelection) => boolean | void>();
let pendingSelection: DesktopWorkPaneSelection | null = null;

/**
 * The desktop navigator and Room route are siblings in Expo's permanent drawer.
 * A tiny browser event keeps corner selection presentation-only: the URL stays
 * on the Room, the middle pane keeps talking, and the right pane opens work.
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

export function writeDesktopCornerDrag(
  dataTransfer: Pick<DataTransfer, 'setData' | 'effectAllowed'>,
  selection: DesktopWorkPaneSelection,
): void {
  dataTransfer.effectAllowed = 'move';
  dataTransfer.setData(DESKTOP_CORNER_DRAG_TYPE, JSON.stringify(selection));
}

export function readDesktopCornerDrag(
  dataTransfer: Pick<DataTransfer, 'getData'>,
): DesktopWorkPaneSelection | null {
  try {
    const parsed = JSON.parse(dataTransfer.getData(DESKTOP_CORNER_DRAG_TYPE)) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as DesktopWorkPaneSelection).roomId !== 'string' ||
      typeof (parsed as DesktopWorkPaneSelection).cornerId !== 'string'
    )
      return null;
    return parsed as DesktopWorkPaneSelection;
  } catch {
    return null;
  }
}
