import { readChatListView } from '@beeline/api-contract/phone';
import { acquireRouterLane, routerFamilyMode, subscribeRouterOwner } from './router-owner';
import { holdRouterConnection } from './router-family';
import type { ChatListConsumer, ChatListHandle, ChatListKey } from './chat-list-store';

/** The navigator owns admission; consumers only observe the one canonical lane.
 * Capability absence parks this removal build and never installs an old watch.
 */
export function acquireRoutedChatList(key: ChatListKey, consumer: ChatListConsumer): ChatListHandle {
  let closed = false;
  const listeners = new Set<() => void>();
  const publish = () => { for (const listener of listeners) listener(); };
  let reported: unknown;
  const lane = acquireRouterLane({ family: 'room-list', workspaceId: key.workspaceId }, consumer.visible, () => {
    if (routerFamilyMode('room-list') === 'router') {
      const state = lane.current();
      if (state.state === 'LIVE' && state.value !== reported) { reported = state.value; consumer.onRead?.(); }
      if (state.state === 'PARKED' && state.error !== reported) { reported = state.error; consumer.onError?.(new Error(state.error!)); }
    }
    publish();
  });
  const stopMode = subscribeRouterOwner(publish);
  const stopConnection = holdRouterConnection();
  return {
    current: () => routerFamilyMode('room-list') === 'router' ? readChatListView(lane.current().value) : null,
    confirmed: () => routerFamilyMode('room-list') === 'router' && lane.current().state === 'LIVE',
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    // Old receipt callbacks may observe visibility but cannot mint read passes.
    force: () => lane.refreshVisibility(), catchUp: () => lane.refreshVisibility(),
    release: () => { if (closed) return; closed = true; stopMode(); lane.release(); stopConnection(); listeners.clear(); },
    remove: async () => {},
  };
}
