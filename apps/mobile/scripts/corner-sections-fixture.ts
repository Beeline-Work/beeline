import type { CornerListItem, CornerListView } from '@beeline/buzz-client';

export const CORNER_SECTIONS_ROOM_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const VIEWER = 'a'.repeat(64);
const SOMEONE = 'b'.repeat(64);
const AGENT = 'c'.repeat(64);
const ARCHIVED_PAGE = 10;

function corner(
  id: string,
  state: CornerListItem['state'],
  initiator: string,
  extra: Partial<CornerListItem> = {},
): CornerListItem {
  return {
    corner: { id, name: id, workspaceId: WORKSPACE_ID, parentId: CORNER_SECTIONS_ROOM_ID },
    lifecycle: { lifecycle: state === 'archived' ? 'done' : 'working', checks: 'unknown' },
    state,
    stateAt: 1_790_000_000,
    initiator: { pubkey: initiator, kind: 'human', name: initiator === VIEWER ? 'Me' : 'Sam' },
    agent: { pubkey: AGENT, kind: 'agent', name: 'Sol' },
    ...extra,
  } as CornerListItem;
}

const view = (corners: readonly CornerListItem[], nextArchived?: string) =>
  ({
    room: { id: CORNER_SECTIONS_ROOM_ID, name: 'alpha', workspaceId: WORKSPACE_ID },
    corners,
    ...(nextArchived ? { nextArchived } : {}),
    apps: [],
    viewer: {
      identity: { pubkey: VIEWER, kind: 'human', name: 'Me' },
      role: 'member',
      permissions: {},
    },
    watchFilters: [],
  }) as unknown as CornerListView;

/** Seven corners that are the viewer's (six commissioned, one waiting on
 * them), more than the five the desktop work pane caps at, and three that are
 * not, one of which waits on someone else. */
const LIVE = [
  ...Array.from({ length: 6 }, (_, index) => corner(`corner-mine-${index + 1}`, 'working', VIEWER)),
  corner('corner-asks-me', 'waiting', SOMEONE, { awaitsViewer: true }),
  corner('corner-theirs-1', 'working', SOMEONE),
  corner('corner-theirs-2', 'review', SOMEONE),
  corner('corner-asks-them', 'waiting', SOMEONE),
];

/** 23 closed corners, newest closure first. */
const ARCHIVED = Array.from({ length: 23 }, (_, index) =>
  corner(`corner-closed-${String(index + 1).padStart(2, '0')}`, 'archived', SOMEONE, {
    closedAt: 1_790_000_000 - index * 3_600,
  }),
);

/** Serves the live list, and the archived list a page at a time the way the
 * server's `nextArchived` cursor does. Records each archived read. */
export const archivedReads: Array<string | null> = [];
export function cornerSectionsView(options: { archived?: boolean; before?: string } = {}) {
  if (!options.archived) return view(LIVE);
  archivedReads.push(options.before ?? null);
  const start = options.before ? Number(options.before) : 0;
  const end = start + ARCHIVED_PAGE;
  return view(ARCHIVED.slice(start, end), end < ARCHIVED.length ? String(end) : undefined);
}
