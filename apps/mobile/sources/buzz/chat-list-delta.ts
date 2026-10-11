import {
  chatActivityAt,
  type ChatListCorner,
} from '@beeline/api-contract/phone';
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

export type ChatListDeltaContext = {
  /** Whether the reader has this Room on screen, so its read mark follows at once. */
  readonly viewing?: (roomId: string) => boolean;
  /** The Room's open corners from the corner store, whose waiting times order the list. */
  readonly openCorners?: (roomId: string) => readonly ChatListCorner[] | undefined;
};

function activityAt(item: ChatListItem, context: ChatListDeltaContext): number {
  return chatActivityAt({ ...item, openCorners: context.openCorners?.(item.room.id) });
}

/** `view` with `item` moved to its place in activity order. */
function placed(
  chats: readonly ChatListItem[],
  item: ChatListItem,
  context: ChatListDeltaContext,
): ChatListItem[] {
  const rest = [...chats];
  const at = rest.findIndex((candidate) => activityAt(candidate, context) <= activityAt(item, context));
  rest.splice(at < 0 ? rest.length : at, 0, item);
  return rest;
}

/** The corner facts a Room list row carries on the wire; the corner store owns them. */
type CornerFacts = Pick<ChatListItem, 'cornerCount' | 'waitingCornerCount' | 'mineCornerCount' | 'openCorners'>;

/** The view without corner facts, once the corner store holds them. */
export function withoutCornerFacts(view: ChatListView): ChatListView {
  if (!view.chats.some((item) => 'cornerCount' in item || 'openCorners' in item)) return view;
  return {
    ...view,
    chats: view.chats.map((item) => {
      const { cornerCount: _count, waitingCornerCount: _waiting, mineCornerCount: _mine,
        openCorners: _corners, ...rest } = item;
      return rest;
    }),
  };
}

/** The view with each Room's corner facts put back, for the saved copy. */
export function withCornerFacts(
  view: ChatListView,
  facts: (roomId: string) => CornerFacts | undefined,
): ChatListView {
  return { ...view, chats: view.chats.map((item) => ({ ...item, ...facts(item.room.id) })) };
}

function applyMessage(
  view: ChatListView,
  index: number,
  message: RoomViewMessage,
  context: ChatListDeltaContext,
): ChatListView {
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
  // Unread is the server's read cursor. Newer incoming activity reopens a
  // closed chat and lights unread unless the Room is on screen, where the read
  // mark follows at once. The viewer's own message, possibly sent from another
  // device, proves nothing about older messages past the cursor: it keeps the
  // held value, and the read-mark frame's read decides.
  const next: ChatListItem = incoming
    ? context.viewing?.(item.room.id)
      ? { ...open, latestMessage: preview }
      : { ...open, latestMessage: preview, unread: true }
    : { ...item, latestMessage: preview };
  const rest = view.chats.filter((_, position) => position !== index);
  return { ...view, chats: placed(rest, next, context) };
}

/**
 * Fold one committed Room delta into the deck. A working turn lights the row;
 * a terminal one cannot clear it here, because the row's state also rolls up
 * every corner's turns — see `chatListDeltaNeedsRead`.
 */
export function applyChatListDelta(
  view: ChatListView,
  delta: ChatListDelta,
  context: ChatListDeltaContext = {},
): ChatListView {
  const index = view.chats.findIndex((item) => item.room.id === delta.roomId);
  if (index < 0) return view;
  const item = view.chats[index]!;
  if (delta.type === 'message-delta') {
    if (delta.message.deleted && 'deckPreview' in delta &&
        item.latestMessage?.id === delta.message.id) {
      const { latestMessage: _old, ...rest } = item;
      const next = { ...rest, ...(delta.deckPreview ? { latestMessage: delta.deckPreview } : {}) };
      const chats = view.chats.filter((_, position) => position !== index);
      return { ...view, chats: placed(chats, next, context) };
    }
    return applyMessage(view, index, delta.message, context);
  }
  if (delta.type === 'corner-status') {
    // The corner store already holds the frame's summary; the row takes its
    // state and moves to its corners' activity.
    const { agentState: _oldState, attentionReason: _oldReason, ...rest } = item;
    const next: ChatListItem = { ...rest,
      ...(delta.agentState ? { agentState: delta.agentState } : {}),
      ...(delta.agentState === 'needs-you'
        ? { attentionReason: delta.attentionReason ?? { kind: 'approval' } } : {}),
    };
    const chats = view.chats.filter((_, position) => position !== index);
    return { ...view, chats: placed(chats, next, context) };
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
 * A read whose unread lookup timed out on the server says nothing about it.
 * Carry each row's last known value instead of painting every dot away until
 * the next read. A row whose unread is unknown and has no last known value
 * keeps `unread` absent, so neither memory nor disk holds it as known and a
 * later incomplete read still sees it as unknown. Corner facts are the corner
 * store's, which a read without them leaves alone.
 */
export function keepUnavailableChatFacts(
  held: ChatListView | null,
  read: ChatListView,
): ChatListView {
  const { unavailable, ...view } = read;
  if (!unavailable?.length && read.chats.every((item) => typeof item.unread === 'boolean')) return read;
  const keepUnread = unavailable?.includes('unread') ?? false;
  const heldById = new Map(held?.chats.map((item) => [item.room.id, item]) ?? []);
  const chats = read.chats.map((item) => {
    const before = heldById.get(item.room.id);
    const { unread, ...rest } = item;
    const knownUnread =
      !keepUnread && typeof unread === 'boolean'
        ? unread
        : typeof before?.unread === 'boolean'
          ? before.unread
          : undefined;
    return { ...rest, ...(knownUnread !== undefined ? { unread: knownUnread } : {}) };
  });
  return chats.some((item) => item.unread === undefined)
    ? { ...view, chats, unavailable: ['unread'] }
    : { ...view, chats };
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
