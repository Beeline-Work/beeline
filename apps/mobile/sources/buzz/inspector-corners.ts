import type { CornerListItem } from '@beeline/buzz-client';

/**
 * Collapsed inspector list length. Five fills a side pane of live work,
 * matches the reporter's starting number, and still leaves one overflow row
 * for the rest. A denser cap would hide live work that fits; a larger one
 * recreates the unbounded dump this list is meant to stop.
 * The Room header's corners screen (`RoomCornersList`) does not use it: that
 * screen shows the viewer's corners uncapped and folds the rest.
 */
export const INSPECTOR_CORNER_LIST_CAP = 5;

export function inspectorCornerObjective(
  title: string,
  about: string | undefined,
): string | undefined {
  const objective = about?.replace(/\s+/g, ' ').trim();
  if (!objective) return undefined;
  const normalizedTitle = title.replace(/\s+/g, ' ').trim();
  if (
    normalizedTitle &&
    objective.localeCompare(normalizedTitle, undefined, { sensitivity: 'accent' }) === 0
  ) {
    return undefined;
  }
  return objective;
}

function isArchived(corner: CornerListItem): boolean {
  return corner.state === 'archived';
}

export type InspectorCornerWindow = {
  readonly visible: readonly CornerListItem[];
  readonly hiddenActive: number;
  readonly hiddenArchived: number;
  readonly overflowLabel: string | null;
};

export function inspectorCornerWindow(
  corners: readonly CornerListItem[],
  expanded: boolean,
  cap = INSPECTOR_CORNER_LIST_CAP,
): InspectorCornerWindow {
  const active = corners.filter((corner) => !isArchived(corner));
  const archived = corners.filter(isArchived);
  if (expanded) {
    return {
      visible: [...active, ...archived],
      hiddenActive: 0,
      hiddenArchived: 0,
      overflowLabel: null,
    };
  }
  const primary = active.length > 0 ? active : archived;
  const visible = primary.slice(0, cap);
  const hiddenPrimary = Math.max(0, primary.length - visible.length);
  const hiddenActive = active.length > 0 ? hiddenPrimary : 0;
  const hiddenArchived = active.length > 0 ? archived.length : hiddenPrimary;
  return {
    visible,
    hiddenActive,
    hiddenArchived,
    overflowLabel: inspectorCornerOverflowLabel(hiddenActive, hiddenArchived, active.length === 0),
  };
}

export function inspectorCornerOverflowLabel(
  hiddenActive: number,
  hiddenArchived: number,
  showingArchivedAlready: boolean,
): string | null {
  const hidden = hiddenActive + hiddenArchived;
  if (hidden <= 0) return null;
  if (!showingArchivedAlready && hiddenActive === 0 && hiddenArchived > 0) {
    return `archived · ${hiddenArchived}`;
  }
  return `${hidden} more`;
}
