import { routerFamilyMode } from '@/buzz/router-owner';
import { RoomViewHttpError } from '@/sync/transport/room-view-client';
import { RoomViewClient } from '@/sync/transport/room-view-client';
import { loadBuzzIdentity, getEffectiveRelayUrl } from '@/auth/buzz-identity-storage';
import { loadActiveCommunityId, saveActiveCommunityId } from '@/buzz/community-storage';
import {
  resolveBuzzNotificationTarget,
  type BuzzNotificationTarget,
} from '@/utils/notificationRouting';

/** Resolve server truth and persist Workspace selection before navigation. */
export async function resolveBuzzNotificationDestination(
  target: BuzzNotificationTarget,
): Promise<BuzzNotificationTarget> {
  let identity = await loadBuzzIdentity();
  if (routerFamilyMode('room-head') !== 'legacy') {
    // Destination focus obtains its own authorized snapshot. A completed
    // corner falls back using that answer, without a parser-time Room read.
    if (identity && target.workspaceId && (await loadActiveCommunityId(identity.publicKey)) !== target.workspaceId)
      await saveActiveCommunityId(identity.publicKey, target.workspaceId);
    return target;
  }
  return resolveBuzzNotificationTarget(target, {
    activateWorkspace: async (workspaceId) => {
      identity ??= await loadBuzzIdentity();
      if (identity && (await loadActiveCommunityId(identity.publicKey)) !== workspaceId) {
        await saveActiveCommunityId(identity.publicKey, workspaceId);
      }
    },
    readRoom: async (roomId) => {
      identity ??= await loadBuzzIdentity();
      if (!identity) throw new Error('notification routing requires an identity');
      const baseUrl = await getEffectiveRelayUrl();
      return new RoomViewClient({ baseUrl, identity }).room(roomId);
    },
    isUnavailableError: (error) =>
      error instanceof RoomViewHttpError && (error.status === 403 || error.status === 404),
  });
}
