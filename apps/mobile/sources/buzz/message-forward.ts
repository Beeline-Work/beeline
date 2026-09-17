import type { AttachmentReference } from '@beeline/api-contract/phone';
import type { ChatListItem } from '@beeline/buzz-client';
import { roomRowName } from '@/buzz/room-list-row';

const FORWARD_CAPTION = /\n\n(FORWARDED FROM #[^\n]+)$/;

export function formatForwardedMessage(text: string, roomName: string): string {
  const quote = text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  const normalizedRoomName = roomName.trim().replace(/^#+/, '');
  return `${quote}\n\nFORWARDED FROM #${normalizedRoomName}`;
}

export function forwardedMessageParts(text: string): { body: string; caption?: string } {
  const match = text.match(FORWARD_CAPTION);
  return match ? { body: text.slice(0, match.index), caption: match[1] } : { body: text };
}

export type ForwardedMessage = {
  roomId: string;
  text: string;
  attachments?: readonly AttachmentReference[];
};

/**
 * Forward a message into another Room. The forwarded message carries the
 * source message's attachments: the media references are Room-agnostic, so
 * re-sending them re-shares the same file without a re-upload. Dropping them
 * here is what made "forward" send the quoted text while the file silently
 * never arrived.
 */
export async function forwardMessageToRoom(
  send: (input: ForwardedMessage) => Promise<unknown>,
  roomId: string,
  message: { text: string; attachments?: readonly AttachmentReference[] },
  sourceRoomName: string,
): Promise<void> {
  await send({
    roomId,
    text: formatForwardedMessage(message.text, sourceRoomName),
    attachments: message.attachments?.length ? message.attachments : undefined,
  });
}

/** One candidate row of the forward picker, named like the Room list names it. */
export type ForwardTarget = { id: string; label: string };

/**
 * Forward destinations: every top-level live Room the viewer can see, DMs
 * included — sharing a file into a DM is a forward's most natural job. Corners
 * (parented Rooms) and archived Rooms are never destinations, and the Room the
 * message came from is excluded.
 */
export function forwardTargets(
  chats: readonly Pick<ChatListItem, 'room' | 'directMessage'>[],
  excludeRoomId: string,
): ForwardTarget[] {
  return chats
    .filter(
      (chat) =>
        chat.room.id !== excludeRoomId && !chat.room.parentId && !chat.room.archived,
    )
    .map((chat) => {
      const row = roomRowName(chat);
      return { id: chat.room.id, label: `${row.sigil}${row.name}` };
    });
}
