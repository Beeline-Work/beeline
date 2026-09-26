import { loadBuzzIdentity, getEffectiveRelayUrl } from '@/auth/buzz-identity-storage';
import { loadActiveCommunityId } from '@/buzz/community-storage';
import { RoomViewClient } from '@/sync/transport/room-view-client';

/** Resolve against the signed-in viewer's current memberships, including personal Settings entry. */
export async function resolveWalletWorkspaceId(routeWorkspaceId?: string): Promise<string | null> {
  const identity = await loadBuzzIdentity();
  if (!identity) return null;
  const [relayUrl, activeId] = await Promise.all([
    getEffectiveRelayUrl(),
    loadActiveCommunityId(identity.publicKey),
  ]);
  const list = await new RoomViewClient({ baseUrl: relayUrl, identity }).workspaces();
  const ids = new Set(list.workspaces.map((workspace) => workspace.id));
  if (routeWorkspaceId && ids.has(routeWorkspaceId)) return routeWorkspaceId;
  if (activeId && ids.has(activeId)) return activeId;
  return list.workspaces[0]?.id ?? null;
}
