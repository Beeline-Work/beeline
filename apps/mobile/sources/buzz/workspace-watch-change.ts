import type { NostrEvent } from '@beeline/nostr';
import type { MonolithSurfaceEvent } from '@/sync/transport/monolith-rig-transport';

const TRANSIENT_REASONS = new Set([
  'message', 'turn', 'activity', 'read-mark', 'corner-status',
  'postgres:live_outputs', 'postgres:agent_turns', 'postgres:agent_activity',
  'postgres:agent_commands', 'postgres:room_read_marks', 'postgres:messages',
  'postgres:needs_you_marks', 'postgres:agent_usage', 'postgres:agent_usage_snapshots',
]);

/** Legacy roster compatibility relevance. A Room transport filter selects an
 * audience, not every source the roster depends on. The negotiated roster
 * family will replace these read hints with complete server-authored facts.
 */
export function workspaceWatchChanges(event: NostrEvent | MonolithSurfaceEvent, scope: {
  workspaceId: string; principal: string; memberIds?: ReadonlySet<string>;
}): boolean {
  if (!('monolithLive' in event)) return [0, 9000, 9001, 9007].includes(event.kind);
  const live = event.monolithLive;
  if (live.workspaceId && live.workspaceId !== scope.workspaceId) return false;
  switch (live.type) {
    case 'invalidate': return !TRANSIENT_REASONS.has(live.reason);
    case 'resource-change': return live.resource === 'agent' &&
      (!live.resourceId || !scope.memberIds || scope.memberIds.has(live.resourceId));
    case 'person-changed': return live.person.pubkey === scope.principal || !scope.memberIds || scope.memberIds.has(live.person.pubkey);
    case 'workspace-changed': return live.workspace.id === scope.workspaceId;
    default: return false;
  }
}
