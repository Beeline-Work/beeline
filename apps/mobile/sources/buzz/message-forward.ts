import type { AttachmentReference } from '@beeline/api-contract/phone';
import type { ChatListItem, RoomViewIdentity, WorkspaceView } from '@beeline/buzz-client';
import { previewHandle, roomRowName } from '@/buzz/room-list-row';

const FORWARD_CAPTION = /\n\n(FORWARDED FROM #[^\n]+)$/;
const FORWARD_SOURCE =
  /\n\n\[(FORWARDED FROM #[^\n\]]+)\]\(beeline:\/\/message-source\/([^/\s]+)\/([^\s)]+)\)$/;

type ForwardAuthor = Pick<RoomViewIdentity, 'name' | 'handle'>;
export type ForwardSource = { roomId: string; messageId: string };

export function formatForwardedMessage(
  text: string,
  roomName: string,
  author: ForwardAuthor,
  source?: ForwardSource,
): string {
  const existingForward = forwardedMessageParts(text);
  const quote = existingForward.body
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
  const normalizedRoomName = roomName.trim().replace(/^#+/, '');
  const caption =
    existingForward.caption ?? `FORWARDED FROM #${normalizedRoomName} · @${previewHandle(author)}`;
  const originalSource = existingForward.source ?? source;
  return originalSource
    ? `${quote}\n\n[${caption}](beeline://message-source/${encodeURIComponent(originalSource.roomId)}/${encodeURIComponent(originalSource.messageId)})`
    : `${quote}\n\n${caption}`;
}

export function forwardedMessageParts(text: string): {
  body: string;
  caption?: string;
  source?: ForwardSource;
} {
  const sourceMatch = text.match(FORWARD_SOURCE);
  // Older clients render this as an ordinary caption-shaped Markdown link.
  // They reveal no transport metadata, and their http-only link handler leaves
  // it inert. This client unwraps the same label and owns the exact jump.
  const visibleText = sourceMatch
    ? `${text.slice(0, sourceMatch.index)}\n\n${sourceMatch[1]}`
    : text;
  let source: ForwardSource | undefined;
  if (sourceMatch) {
    try {
      const roomId = decodeURIComponent(sourceMatch[2]!);
      const messageId = decodeURIComponent(sourceMatch[3]!);
      if (roomId && messageId) source = { roomId, messageId };
    } catch {
      // A malformed marker is never navigation authority. It remains hidden,
      // while the forwarded quote itself continues to render normally.
    }
  }
  const captionMatch = visibleText.match(FORWARD_CAPTION);
  return {
    body: captionMatch ? visibleText.slice(0, captionMatch.index) : visibleText,
    ...(captionMatch ? { caption: captionMatch[1] } : {}),
    ...(source ? { source } : {}),
  };
}

export type ForwardedMessage = {
  roomId: string;
  text: string;
  attachments?: readonly AttachmentReference[];
};

/**
 * Forward a message into another Room. The forwarded message carries the
 * source message's attachments and provenance. The media references are
 * Room-agnostic, so re-sending them re-shares the same file without a
 * re-upload. An already-forwarded message keeps its first source and author,
 * rather than being re-attributed to the person who forwarded it again.
 */
export async function forwardMessageToRoom(
  send: (input: ForwardedMessage) => Promise<unknown>,
  roomId: string,
  message: {
    text: string;
    author: ForwardAuthor;
    attachments?: readonly AttachmentReference[];
    source?: ForwardSource;
  },
  sourceRoomName: string,
): Promise<void> {
  await send({
    roomId,
    text: formatForwardedMessage(message.text, sourceRoomName, message.author, message.source),
    attachments: message.attachments?.length ? message.attachments : undefined,
  });
}

/** One candidate row of the forward picker, named like the Room list names it. */
export type ForwardTargetGroup = 'people' | 'agents' | 'rooms';

export type ForwardTarget =
  | { kind: 'room'; id: string; label: string; group: ForwardTargetGroup }
  | {
      kind: 'member';
      id: string;
      label: string;
      memberId: string;
      group: Exclude<ForwardTargetGroup, 'rooms'>;
    };

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
      const group = chat.directMessage
        ? chat.directMessage.peer.kind === 'agent'
          ? 'agents'
          : 'people'
        : 'rooms';
      return {
        kind: 'room' as const,
        id: chat.room.id,
        label: `${row.sigil}${row.name}`,
        group,
      };
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
      group: identity.kind === 'agent' ? ('agents' as const) : ('people' as const),
    }));
  return [...roomTargets, ...memberTargets];
}
