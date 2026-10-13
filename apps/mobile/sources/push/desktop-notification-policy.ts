import type { ChatListItem, RoomViewMessage } from '@beeline/buzz-client';
import type { PushLevel } from '@beeline/api-contract/phone';

/** Apply the same message tiers to native desktop notifications. */
export function desktopMessageMayNotify(input: {
  message: RoomViewMessage;
  room: ChatListItem;
  viewerPubkey: string;
  level: PushLevel;
  repliedToViewer?: boolean;
  finalAgentTurn?: boolean;
  openChannelId: string | null;
  windowFocused: boolean;
}): boolean {
  const { message, room, viewerPubkey, level } = input;
  if (level === 'off' || input.windowFocused || input.openChannelId === room.room.id) return false;
  if (message.deleted || !message.text.trim() || message.author.pubkey === viewerPubkey)
    return false;
  if (message.presentation === 'activity') return false;
  if (message.presentation === 'card' && !message.grantRequest) return false;
  if (message.grantRequest?.grants?.every((grant) => grant.auto)) return false;
  if (
    message.presentation === 'message' &&
    message.author.kind === 'agent' &&
    message.requestId &&
    !input.finalAgentTurn
  )
    return false;
  return Boolean(
    (level === 'full' && message.presentation === 'message') ||
    room.directMessage ||
    message.mentionPubkeys?.includes(viewerPubkey) ||
    input.repliedToViewer,
  );
}
