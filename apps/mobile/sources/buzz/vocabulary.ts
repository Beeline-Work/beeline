/** Product vocabulary. Keep person-facing display nouns centralized here. */
export const WORKSPACE_LABEL = 'Workspace';
export const ROOM_LABEL = 'Room';
export const CORNER_LABEL = 'corner';
export const CHANGE_LABEL = `a ${CORNER_LABEL}`;

export const WORKSPACES_LABEL = `${WORKSPACE_LABEL}s`;
export const ROOMS_LABEL = `${ROOM_LABEL}s`;
export const CHANGES_LABEL = `${CORNER_LABEL}s`;

/**
 * The one word for "the people and agents in this Workspace", used by every
 * route into the members screen — the Room-list header, the empty-state entry,
 * and Workspace settings. Three surfaces previously reached the same screen
 * under three different words ("PEOPLE", "Members", "MEMBERS").
 *
 * Chrome next to bookmarks uses an outline people glyph from the same Ionicons
 * family; the word remains the accessible name and the in-list entries' title.
 * The angular hexagon `⌬` (captain report C73) stays retired: it never belonged
 * to the creature motif, and a Speakeasy animal would collide with identity
 * marks. `members-glyph.test.ts` holds that rule.
 */
export const MEMBERS_LABEL = 'Members';

/**
 * "N corner"/"N corners" for a Room row's meta line, or `null` when there are
 * none to report. The server count already excludes terminal corners (landed,
 * closed, archived), matching what the corner dropdown and pinned line show —
 * so a Room whose corners are all terminal renders no corner count at all
 * rather than a stale "0 corners".
 */
export function formatRoomCornerCount(count: number): string | null {
  if (count <= 0) return null;
  return `${count} ${count === 1 ? CORNER_LABEL : CHANGES_LABEL}`;
}
