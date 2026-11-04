import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { loadActiveCommunityId, saveActiveCommunityId } from '@/buzz/community-storage';
import {
  type BuzzNotificationTarget,
} from '@/utils/notificationRouting';

/** Resolve server truth and persist Workspace selection before navigation. */
export async function resolveBuzzNotificationDestination(
  target: BuzzNotificationTarget,
): Promise<BuzzNotificationTarget> {
  let identity = await loadBuzzIdentity();

    // Destination focus obtains its own authorized snapshot. A completed
    // corner falls back using that answer, without a parser-time Room read.
    if (identity && target.workspaceId && (await loadActiveCommunityId(identity.publicKey)) !== target.workspaceId)
      await saveActiveCommunityId(identity.publicKey, target.workspaceId);
    return target;
}
