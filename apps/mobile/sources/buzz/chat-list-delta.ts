import { chatActivityAt, type ChatListCorner } from '@beeline/api-contract/phone';
import type {
  ChatListItem,
  ChatListView,
  RoomViewAgentTurn,
  RoomViewMessage,
} from '@beeline/buzz-client';

export type ChatListDelta =
  | { readonly type: 'message-delta'; readonly roomId: string; readonly message: RoomViewMessage;
      readonly deckPreview?: ChatListItem['latestMessage'] | null }
  | { readonly type: 'turn-delta'; readonly roomId: string; readonly turn: RoomViewAgentTurn;
      readonly agentState?: 'needs-you' | 'working' | null;
      readonly attentionReason?: ChatListItem['attentionReason'] }
  | { readonly type: 'corner-status'; readonly roomId: string; readonly cornerCount: number;
      readonly waitingCornerCount: number; readonly mineCornerCount?: number;
      readonly openCorners: readonly ChatListCorner[];
      readonly agentState: 'needs-you' | 'working' | null;
      readonly attentionReason?: ChatListItem['attentionReason'] };

/** The presentations the server's deck preview reads its latest message from. */
const PREVIEW_PRESENTATIONS: ReadonlySet<RoomViewMessage['presentation']> = new Set([
  'message',
  'system',
  'card',
]);

function applyMessage(view: ChatListView, index: number, message: RoomViewMessage): ChatListView {
  const item = view.chats[index]!;
  const latest = item.latestMessage;
  if (message.deleted || !PREVIEW_PRESENTATIONS.has(message.presentation)) return view;
  if (latest && (latest.createdAt > message.createdAt ||
    (latest.createdAt === message.createdAt && latest.id > message.id))) return view;
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
  const at = rest.findIndex((candidate) => chatActivityAt(candidate) <= chatActivityAt(next));
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
  const item = view.chats[index]!;
  if (delta.type === 'message-delta') {
    if (delta.message.deleted && 'deckPreview' in delta &&
        item.latestMessage?.id === delta.message.id) {
      const { latestMessage: _old, ...rest } = item;
      const next = { ...rest, ...(delta.deckPreview ? { latestMessage: delta.deckPreview } : {}) };
      const chats = view.chats.filter((_, position) => position !== index);
      const at = chats.findIndex((candidate) => chatActivityAt(candidate) <= chatActivityAt(next));
      chats.splice(at < 0 ? chats.length : at, 0, next);
      return { ...view, chats };
    }
    return applyMessage(view, index, delta.message);
  }
  if (delta.type === 'corner-status') {
    const { agentState: _oldState, attentionReason: _oldReason, mineCornerCount: _oldMine,
      ...rest } = item;
    const next: ChatListItem = { ...rest,
      cornerCount: delta.cornerCount,
      waitingCornerCount: delta.waitingCornerCount,
      ...(delta.mineCornerCount !== undefined ? { mineCornerCount: delta.mineCornerCount } : {}),
      openCorners: delta.openCorners,
      ...(delta.agentState ? { agentState: delta.agentState } : {}),
      ...(delta.agentState === 'needs-you'
        ? { attentionReason: delta.attentionReason ?? { kind: 'approval' } } : {}),
    };
    const chats = view.chats.filter((_, position) => position !== index);
    const at = chats.findIndex((candidate) => chatActivityAt(candidate) <= chatActivityAt(next));
    chats.splice(at < 0 ? chats.length : at, 0, next);
    return { ...view, chats };
  }
  if ('agentState' in delta) {
    const { agentState: _oldState, attentionReason: _oldReason, ...rest } = item;
    const chats = [...view.chats];
    chats[index] = { ...rest,
      ...(delta.agentState ? { agentState: delta.agentState } : {}),
      ...(delta.agentState === 'needs-you'
        ? { attentionReason: delta.attentionReason ?? { kind: 'approval' as const } } : {}),
    };
    return { ...view, chats };
  }
  if (delta.turn.status !== 'working' || item.agentState) return view;
  const chats = [...view.chats];
  chats[index] = { ...item, agentState: 'working' };
  return { ...view, chats };
}

/** Older live frames without a preview or terminal state need one covering read. */
export function chatListDeltaNeedsRead(view: ChatListView, delta: ChatListDelta): boolean {
  if (delta.type === 'corner-status') return false;
  if (delta.type === 'message-delta') {
    return delta.message.deleted === true && !('deckPreview' in delta) && view.chats.some((item) =>
      item.room.id === delta.roomId && item.latestMessage?.id === delta.message.id);
  }
  return !('agentState' in delta) && delta.turn.status !== 'working' &&
    view.chats.find((item) => item.room.id === delta.roomId)?.agentState === 'working';
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

/**
 * A read whose unread or corner lookup timed out on the server says nothing
 * about those facts. Carry each row's last known values instead of painting
 * every dot and corner count away until the next read.
 */
export function keepUnavailableChatFacts(
  held: ChatListView | null,
  read: ChatListView,
): ChatListView {
  const { unavailable, ...view } = read;
  if (!unavailable?.length) return read;
  const heldById = new Map(held?.chats.map((item) => [item.room.id, item]) ?? []);
  const keepUnread = unavailable.includes('unread');
  const keepCorners = unavailable.includes('corners');
  return {
    ...view,
    chats: read.chats.map((item) => {
      const before = heldById.get(item.room.id);
      if (!before) return item;
      return {
        ...item,
        ...(keepUnread ? { unread: before.unread } : {}),
        ...(keepCorners
          ? {
              ...(before.cornerCount !== undefined ? { cornerCount: before.cornerCount } : {}),
              ...(before.waitingCornerCount !== undefined
                ? { waitingCornerCount: before.waitingCornerCount }
                : {}),
              ...(before.mineCornerCount !== undefined
                ? { mineCornerCount: before.mineCornerCount }
                : {}),
              ...(before.openCorners ? { openCorners: before.openCorners } : {}),
            }
          : {}),
      };
    }),
  };
}

/**
 * The deck's watch identity. The server lists Room ids newest-activity first,
 * so every reorder would otherwise read as a new watch and resubscribe the
 * whole deck; the set of Rooms, not their order, is what the watch covers.
 */
export function chatWatchFiltersKey(filters: ChatListView['watchFilters']): string {
  return JSON.stringify(
    filters
      .map((filter) =>
        JSON.stringify(
          Object.entries(filter)
            .map(([key, values]) => [key, [...(values as readonly (string | number)[])].sort()])
            .sort(([left], [right]) => String(left).localeCompare(String(right))),
        ),
      )
      .sort(),
  );
}
