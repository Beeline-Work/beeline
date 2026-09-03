import type { ChatListItem } from '@beeline/buzz-client';

/** The one state vocabulary the Room deck's circle renders. */
export type RoomDeckState = 'needs-you' | 'working' | 'idle';

/**
 * The deck row's single circle state, inherited from the server's
 * `ChatListItem.agentState` rollup — the Room's own conversational turn AND
 * every one of its corners — combined with the independent message-unread
 * signal.
 *
 * Precedence is fixed: needs-you (a corner waiting on a human) outranks
 * working (the Room's own turn or any corner actively working), which
 * outranks plain unread. A live turn must never be hidden behind an unread
 * gold dot — plain unread still renders its NEW badge (channels.tsx reads
 * `item.unread` directly), but only golds the circle when no agent activity
 * outranks it. This is the one place that precedence is decided, so a live
 * turn or a corner's needs-you can never be silently dropped by a future
 * render change — see `room-deck-state.test.ts`.
 */
export function roomDeckState(chat: Pick<ChatListItem, 'unread' | 'agentState'>): RoomDeckState {
  if (chat.agentState === 'needs-you') return 'needs-you';
  if (chat.agentState === 'working') return 'working';
  if (chat.unread) return 'needs-you';
  return 'idle';
}
