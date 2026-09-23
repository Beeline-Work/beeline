import type {
  ChatListItem,
  ChatListView,
  RoomViewAgentTurn,
  RoomViewMessage,
} from '@beeline/buzz-client';

export type ChatListDelta =
  | { readonly type: 'message-delta'; readonly roomId: string; readonly message: RoomViewMessage }
  | { readonly type: 'turn-delta'; readonly roomId: string; readonly turn: RoomViewAgentTurn };

/** The presentations the server's deck preview reads its latest message from. */
const PREVIEW_PRESENTATIONS: ReadonlySet<RoomViewMessage['presentation']> = new Set([
  'message',
  'system',
  'card',
]);

function activityAt(item: ChatListItem): number {
  return item.latestMessage?.createdAt ?? item.room.updatedAt ?? 0;
}

function applyMessage(view: ChatListView, index: number, message: RoomViewMessage): ChatListView {
  const item = view.chats[index]!;
  const latest = item.latestMessage;
  if (!PREVIEW_PRESENTATIONS.has(message.presentation)) return view;
  if (latest && latest.createdAt > message.createdAt) return view;
  const preview: NonNullable<ChatListItem['latestMessage']> = {
    id: message.id,
    text: message.text,
    createdAt: message.createdAt,
    author: message.author,
    ...(message.attachments?.length ? { attachments: message.attachments } : {}),
  };
  if (latest?.id === message.id) {
    // The same row edited or reacted to: its read state is unchanged.
    const chats = [...view.chats];
    chats[index] = { ...item, latestMessage: preview };
    return { ...view, chats };
  }
  const incoming = message.author.pubkey !== view.viewer.pubkey;
  const { closed: _closed, ...open } = item;
  // Newer incoming activity reopens a closed chat and lights unread; the
  // viewer's own message is written from inside the Room it has read.
  const next: ChatListItem = incoming
    ? { ...open, latestMessage: preview, unread: true }
    : { ...item, latestMessage: preview, unread: false };
  const rest = view.chats.filter((_, position) => position !== index);
  const at = rest.findIndex((candidate) => activityAt(candidate) <= message.createdAt);
  rest.splice(at < 0 ? rest.length : at, 0, next);
  return { ...view, chats: rest };
}

/**
 * Fold one committed Room delta into the deck. A working turn lights the row;
 * a terminal one cannot clear it here, because the row's state also rolls up
 * every corner's turns — see `chatListDeltaNeedsRead`.
 */
export function applyChatListDelta(view: ChatListView, delta: ChatListDelta): ChatListView {
  const index = view.chats.findIndex((item) => item.room.id === delta.roomId);
  if (index < 0) return view;
  if (delta.type === 'message-delta') return applyMessage(view, index, delta.message);
  const item = view.chats[index]!;
  if (delta.turn.status !== 'working' || item.agentState) return view;
  const chats = [...view.chats];
  chats[index] = { ...item, agentState: 'working' };
  return { ...view, chats };
}

/** A settled turn on a working row: only the server knows whether anything else still works. */
export function chatListDeltaNeedsRead(view: ChatListView, delta: ChatListDelta): boolean {
  if (delta.type !== 'turn-delta' || delta.turn.status === 'working') return false;
  return view.chats.find((item) => item.room.id === delta.roomId)?.agentState === 'working';
}

/**
 * Rooms whose read shows a newer latest message than the deck held although
 * the socket delivered nothing for them since the previous read: proof the
 * socket missed those events.
 */
export function roomsMissedByLive(
  held: ChatListView,
  read: ChatListView,
  heardRoomIds: ReadonlySet<string>,
): string[] {
  const heldById = new Map(held.chats.map((item) => [item.room.id, item]));
  return read.chats.flatMap((item) => {
    const before = heldById.get(item.room.id);
    const latest = item.latestMessage;
    if (!before || !latest || heardRoomIds.has(item.room.id)) return [];
    const previous = before.latestMessage;
    // Times are whole seconds, so a different message in the same second is also new.
    const newer =
      !previous ||
      latest.createdAt > previous.createdAt ||
      (latest.createdAt === previous.createdAt && latest.id !== previous.id);
    return newer ? [item.room.id] : [];
  });
}
