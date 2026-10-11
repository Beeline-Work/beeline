import { loadBuzzIdentity, getEffectiveRelayUrl } from '@/auth/buzz-identity-storage';
import { loadActiveCommunityId } from '@/buzz/community-storage';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { isWorkspaceListView } from '@beeline/buzz-client';
import { mobileSurfaceCache, surfaceAddress } from './surface-storage';

/**
 * Resolve against the signed-in viewer's current memberships, including personal Settings entry.
 * Pass the followed current Workspace (useActiveCommunityId) once known; omitted, storage seeds it.
 */
export async function resolveWalletWorkspaceId(
  routeWorkspaceId?: string,
  currentWorkspaceId?: string | null,
): Promise<string | null> {
  const identity = await loadBuzzIdentity();
  if (!identity) return null;
  const [relayUrl, activeId] = await Promise.all([
    getEffectiveRelayUrl(),
    currentWorkspaceId === undefined ? loadActiveCommunityId(identity.publicKey) : currentWorkspaceId,
  ]);
  const address = surfaceAddress(relayUrl, identity.publicKey, '/workspaces');
  const list = await mobileSurfaceCache.read(address, isWorkspaceListView) ??
    await mobileSurfaceCache.fetch(address, isWorkspaceListView, () =>
      new RoomViewClient({ baseUrl: relayUrl, identity }).workspaces());
  if (!list) return null;
  const ids = new Set(list.workspaces.map((workspace) => workspace.id));
  if (routeWorkspaceId && ids.has(routeWorkspaceId)) return routeWorkspaceId;
  if (activeId && ids.has(activeId)) return activeId;
  return list.workspaces[0]?.id ?? null;
}
