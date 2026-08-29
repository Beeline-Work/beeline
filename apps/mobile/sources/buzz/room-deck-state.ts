import type { ChatListItem } from '@beeline/buzz-client';

/** The one state vocabulary the Room deck's circle renders. */
export type RoomDeckState = 'needs-you' | 'working' | 'idle';

/**
 * The deck row's single circle state, inherited from the server's
 * max-severity `ChatListItem.agentState` rollup — the Room's own
 * conversational turn AND every one of its corners — combined with the
 * independent message-unread signal.
 *
 * Precedence is fixed: needs-you (an unread message, OR a corner waiting on
 * a human) outranks working (the Room's own turn or any corner actively
 * working), which outranks idle. This is the one place that precedence is
 * decided, so a live turn or a corner's needs-you can never be silently
 * dropped by a future render change — see `room-deck-state.test.ts`.
 */
export function roomDeckState(chat: Pick<ChatListItem, 'unread' | 'agentState'>): RoomDeckState {
  if (chat.unread || chat.agentState === 'needs-you') return 'needs-you';
  if (chat.agentState === 'working') return 'working';
  return 'idle';
}
