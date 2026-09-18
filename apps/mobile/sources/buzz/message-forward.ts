import type { AttachmentReference } from '@beeline/api-contract/phone';
import type { ChatListItem, WorkspaceView } from '@beeline/buzz-client';
import { previewHandle, roomRowName } from '@/buzz/room-list-row';

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
export type ForwardTarget =
  | { kind: 'room'; id: string; label: string }
  | { kind: 'member'; id: string; label: string; memberId: string };

/** Resolve a member-backed destination only when the viewer selects it. */
export async function resolveForwardTargetRoom(
  target: ForwardTarget,
  workspaceId: string,
  resolveDirectMessage: (workspaceId: string, memberId: string) => Promise<{ channelId: string }>,
): Promise<string> {
  if (target.kind === 'room') return target.id;
  return (await resolveDirectMessage(workspaceId, target.memberId)).channelId;
}

/**
 * Forward destinations: every top-level live Room the viewer can see, DMs
 * included, followed by Workspace peers who do not have a DM yet. Selecting a
 * peer resolves their DM before sending. Existing DMs stay Room destinations
 * and are not duplicated as member rows. Corners, archived Rooms, the viewer,
 * and the Room the message came from are never destinations.
 */
export function forwardTargets(
  chats: readonly Pick<ChatListItem, 'room' | 'directMessage'>[],
  workspace: Pick<WorkspaceView, 'members' | 'agents' | 'viewer'>,
  excludeRoomId: string,
): ForwardTarget[] {
  const representedDmPeers = new Set(
    chats.flatMap((chat) =>
      chat.directMessage?.peer.pubkey ? [chat.directMessage.peer.pubkey] : [],
    ),
  );
  const roomTargets: ForwardTarget[] = chats
    .filter(
      (chat) =>
        chat.room.id !== excludeRoomId && !chat.room.parentId && !chat.room.archived,
    )
    .map((chat) => {
      const row = roomRowName(chat);
      return { kind: 'room', id: chat.room.id, label: `${row.sigil}${row.name}` };
    });
  const memberTargets: ForwardTarget[] = [...workspace.members, ...workspace.agents]
    .filter(
      (member) =>
        member.identity.pubkey !== workspace.viewer.identity.pubkey &&
        !representedDmPeers.has(member.identity.pubkey),
    )
    .map(({ identity }) => ({
      kind: 'member',
      id: identity.pubkey,
      label: `@${previewHandle(identity)}`,
      memberId: identity.pubkey,
    }));
  return [...roomTargets, ...memberTargets];
}
