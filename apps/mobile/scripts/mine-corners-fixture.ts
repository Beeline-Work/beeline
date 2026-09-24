import type { CornerListItem, CornerListView } from '@beeline/buzz-client';

export const MINE_CORNERS_ROOM_ID = '11111111-1111-4111-8111-111111111111';
const WORKSPACE_ID = '22222222-2222-4222-8222-222222222222';
const VIEWER = 'a'.repeat(64);
const SOMEONE = 'b'.repeat(64);
const AGENT = 'c'.repeat(64);

function corner(
  id: string,
  state: CornerListItem['state'],
  initiator: string,
  awaitsViewer = false,
): CornerListItem {
  return {
    corner: { id, name: id, workspaceId: WORKSPACE_ID, parentId: MINE_CORNERS_ROOM_ID },
    lifecycle: { lifecycle: 'working', checks: 'unknown' },
    state,
    stateAt: 1_790_000_000,
    initiator: { pubkey: initiator, kind: 'human', name: initiator === VIEWER ? 'Me' : 'Sam' },
    agent: { pubkey: AGENT, kind: 'agent', name: 'Sol' },
    ...(awaitsViewer ? { awaitsViewer: true as const } : {}),
  };
}

/** One corner the viewer commissioned, one that awaits them, and two that are
 * someone else's, one of which is waiting on someone else. */
export const MINE_CORNERS_FIXTURE = {
  room: { id: MINE_CORNERS_ROOM_ID, name: 'alpha', workspaceId: WORKSPACE_ID },
  corners: [
    corner('corner-mine', 'working', VIEWER),
    corner('corner-waiting', 'waiting', SOMEONE, true),
    corner('corner-theirs', 'working', SOMEONE),
    corner('corner-theirs-waiting', 'waiting', SOMEONE),
  ],
  apps: [],
  viewer: {
    identity: { pubkey: VIEWER, kind: 'human', name: 'Me' },
    role: 'member',
    permissions: {},
  },
  watchFilters: [],
} as unknown as CornerListView;
