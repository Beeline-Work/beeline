import type { ChatListItem, RoomViewMessage } from '@beeline/buzz-client';
import type { PushLevel } from '@beeline/api-contract/phone';

/** Mirror the direct-message/tag/reply ceiling used by the server push worker. */
export function desktopMessageMayNotify(input: {
  message: RoomViewMessage;
  room: ChatListItem;
  viewerPubkey: string;
  level: PushLevel;
  repliedToViewer?: boolean;
  openChannelId: string | null;
  windowFocused: boolean;
}): boolean {
  const { message, room, viewerPubkey, level } = input;
  if (level === 'off' || input.windowFocused || input.openChannelId === room.room.id) return false;
  if (message.deleted || !message.text.trim() || message.author.pubkey === viewerPubkey)
    return false;
  if (message.presentation === 'activity' || message.relay?.direction === 'up') return false;
  if (message.presentation === 'card' && !message.grantRequest) return false;
  if (message.grantRequest?.grants?.every((grant) => grant.auto)) return false;
  return Boolean(
    room.directMessage || message.mentionPubkeys?.includes(viewerPubkey) || input.repliedToViewer,
  );
}
