import type { RouterFamily } from '@beeline/api-contract/router-protocol';
import { RouterProjectionUnavailable } from './router-projections.js';

/** Explicit dependency classification. Unknown journal shapes park; they never
 * mean 'refresh everything'. This table is not a claim of schema closure. */
const dependencies: Readonly<Record<string, readonly RouterFamily[]>> = {
  messages: ['room-list','needs-you','needs-you-count','room-head'],
  memberships: ['room-list','needs-you','needs-you-count','room-head'],
  identities: ['room-list','needs-you','needs-you-count','room-head'],
  rooms: ['room-list','needs-you','needs-you-count','room-head'],
  workspaces: ['room-list'],
  room_read_marks: ['room-list','room-head'],
  needs_you_marks: ['needs-you','needs-you-count'],
  agent_commands: ['room-list','room-head'],
  agent_turns: ['room-list','room-head'],
  corner_facts: ['room-list','room-head'],
  corner_person_state: ['room-list','room-head'],
  corner_owed: ['room-list','room-head'],
  corner_follows: ['room-list'],
  corner_brief_revisions: ['room-list','room-head'],
  corner_merge_holds: ['room-list','room-head'],
  agent_grants: ['needs-you','needs-you-count','room-head'],
  permission_authority: ['needs-you','needs-you-count','room-head'],
  message_bookmarks: ['room-head'],
  feedback_items: ['room-head'],
  objects: ['room-head'],
  object_expirations: ['room-head'],
  voice_calls: ['room-list','room-head'],
  chat_dismissals: ['room-list'],
  // These tables do not enter any of the first four DTOs.
  agent_schedules: [], agent_subscriptions: [],
};
export function routerSourcePlan(causes: readonly Record<string,unknown>[], viewer: string) {
  const families = new Set<RouterFamily>(), rooms = new Set<string>(), removedRooms = new Set<string>();
  let allRooms = false;
  for (const cause of causes) {
    const table = cause.sourceTable;
    if (typeof table !== 'string' || !Object.hasOwn(dependencies,table))
      throw new RouterProjectionUnavailable('dependency');
    if (['room_read_marks','needs_you_marks','message_bookmarks','chat_dismissals'].includes(table) &&
      typeof cause.identityId === 'string' && cause.identityId !== viewer) continue;
    for (const family of dependencies[table]!) families.add(family);
    if (typeof cause.sourceRoomId === 'string') {
      rooms.add(cause.sourceRoomId);
      if (cause.sourceRemoved===true || (table==='rooms' && cause.operation==='DELETE') || (table==='memberships' && cause.removed===true && cause.identityId===viewer)) removedRooms.add(cause.sourceRoomId);
    }
    if (typeof cause.oldRoomId === 'string') rooms.add(cause.oldRoomId);
    if (typeof cause.newRoomId === 'string') rooms.add(cause.newRoomId);
    if (typeof cause.parentRoomId === 'string') rooms.add(cause.parentRoomId);
    if (['memberships','identities'].includes(table) || (families.has('room-head') && !cause.sourceRoomId)) allRooms = true;
  }
  return {families,rooms,removedRooms,allRooms};
}
