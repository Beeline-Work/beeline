import { router } from 'expo-router';
import { navigateToRoom } from '@/buzz/corner-navigation';

/**
 * Land in a Workspace the person just created or joined: its Room deck
 * becomes the screen underneath (so back leaves the Room for the deck, not
 * for the setup flow), and the given Room opens on top. Without a Room the
 * deck alone is the landing.
 */
export function enterWorkspaceRoom(workspaceId: string, roomId: string | null | undefined): void {
  router.replace({ pathname: '/beeline/channels', params: { communityId: workspaceId } });
  if (roomId) setTimeout(() => navigateToRoom(router, roomId), 0);
}
