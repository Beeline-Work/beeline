import type { NostrEvent } from '@beeline/nostr';
import type { MonolithSurfaceEvent } from '@/sync/transport/monolith-rig-transport';

/** Only changes that can alter the server-owned Workspace list. */
export function invalidatesWorkspaceList(event: NostrEvent | MonolithSurfaceEvent): boolean {
  if (!('monolithLive' in event)) return [9000, 9001, 9007].includes(event.kind);
  const live = event.monolithLive;
  return live.type === 'workspace-changed' ||
    (live.type === 'invalidate' && live.roomId === '' &&
      ['reconnect', 'postgres:memberships', 'postgres:workspaces'].includes(live.reason));
}
