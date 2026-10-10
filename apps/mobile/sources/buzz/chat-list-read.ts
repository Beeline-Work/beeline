import type { ChatListView } from '@beeline/buzz-client';
import { loadBuzzIdentity } from '@/auth/buzz-identity-storage';
import { RoomViewClient } from '@/sync/transport/room-view-client';

/** The server's Room list for one Workspace, read as the viewer the key names. */
export async function readChatListFromServer(
  relayUrl: string,
  viewerPubkey: string,
  workspaceId: string,
): Promise<ChatListView> {
  const identity = await loadBuzzIdentity();
  // A read for another account would land in this viewer's list.
  if (!identity || identity.publicKey !== viewerPubkey)
    throw new Error('The signed-in identity changed before the Room list was read.');
  return new RoomViewClient({ baseUrl: relayUrl, identity }).chats(workspaceId);
}
