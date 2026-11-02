import { readChatListView } from '@beeline/api-contract/phone';
import { acquireRouterLane, routerFamilyMode, subscribeRouterOwner } from './router-owner';
import { holdRouterConnection } from './router-family';
import type { ChatListConsumer, ChatListHandle, ChatListKey } from './chat-list-store';

/** A family changes owners only at a negotiated epoch. The previous legacy
 * scheduler/watch is disposed before the router lane is attached.
 */
export function acquireRoutedChatList(key: ChatListKey, consumer: ChatListConsumer,
  legacy: () => ChatListHandle): ChatListHandle {
  let current: ChatListHandle | undefined;
  let mode: ReturnType<typeof routerFamilyMode> = 'pending';
  let stopCurrent: (() => void) | undefined;
  let closed = false;
  const listeners = new Set<() => void>();
  const publish = () => { for (const listener of listeners) listener(); };
  const request = { family: 'room-list' as const, workspaceId: key.workspaceId };
  let reported: unknown;
  const lane = acquireRouterLane(request, consumer.visible, () => {
    if (mode === 'router') {
      const state = lane.current();
      if (state.state === 'LIVE' && state.value !== reported) { reported = state.value; consumer.onRead?.(); }
      if (state.state === 'PARKED' && state.error !== reported) { reported = state.error; consumer.onError?.(new Error(state.error!)); }
      publish();
    }
  });
  const choose = () => {
    const next = routerFamilyMode('room-list');
    if (closed || next === mode && current) return;
    if (next === mode && next === 'pending') return;
    stopCurrent?.(); stopCurrent = undefined;
    current?.release(); current = undefined;
    mode = next;
    if (next === 'legacy') {
      current = legacy(); stopCurrent = current.subscribe(publish);
    } else if (next === 'router') {
      current = {
        current: () => readChatListView(lane.current().value),
        confirmed: () => lane.current().state === 'LIVE', subscribe: lane.subscribe,
        // These compatibility callbacks may come from invalidations or command
        // receipts. They may observe visibility, never create a new read pass.
        force: () => lane.refreshVisibility(), catchUp: () => lane.refreshVisibility(),
        release: () => {},
        remove: async () => {},
      };
      publish();
    }
    publish();
  };
  const stopMode = subscribeRouterOwner(choose);
  const stopConnection = holdRouterConnection();
  choose();
  return {
    current: () => current?.current() ?? null,
    confirmed: () => current?.confirmed() ?? false,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    force: () => current?.force(), catchUp: () => current?.catchUp(),
    release: () => { if (closed) return; closed = true; stopMode(); stopCurrent?.(); current?.release(); lane.release(); stopConnection(); listeners.clear(); },
    remove: async () => { await current?.remove(); },
  };
}
