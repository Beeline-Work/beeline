import { useCallback, useRef, useSyncExternalStore } from 'react';
import { isChatListView, type ChatListView } from '@beeline/buzz-client';
import { readChatListView } from '@beeline/api-contract/phone';
import { resetClientState } from '@/sync/client-reset';
import { useRouterFamily, holdRouterConnection } from './router-family';
import { acquireRouterLane, acquireRouterForwardList, routerLaneSnapshot, routerFamilyMode, subscribeRouterOwner } from './router-owner';

export type ChatListKey = { readonly relayUrl: string; readonly viewerPubkey: string; readonly workspaceId: string };
export type ChatListConsumer = { readonly visible: () => boolean; readonly onRead?: () => void; readonly onError?: (reason: unknown) => void };
export interface ChatListHandle {
  current(): ChatListView | null;
  confirmed(): boolean;
  subscribe(listener: () => void): () => void;
  force(): void;
  catchUp(): void;
  release(): void;
  remove(): Promise<void>;
}

export function acquireChatList(key: ChatListKey, consumer: ChatListConsumer): ChatListHandle {
  return acquireRoutedChatList(key, consumer);
}
export function liveChatList(key: ChatListKey): ChatListView | null {
  if (routerFamilyMode('room-list') !== 'router') return null;
  const view = routerLaneSnapshot({ family: 'room-list', workspaceId: key.workspaceId });
  return view.state === 'LIVE' && isChatListView(view.value) ? view.value : null;
}
export const chatListSnapshot = liveChatList;
export const resetChatListStoresForTest = resetClientState;

/** The navigator owns admission; consumers only observe the one canonical lane.
 * Capability absence parks this removal build and never installs an old watch.
 */
function acquireRoutedChatList(key: ChatListKey, consumer: ChatListConsumer): ChatListHandle {
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

/** The app badge observes the canonical count lane on the main socket. */
export function useNeedsYouCount(workspaceId: string | null | undefined, refreshKey: unknown, visible?: () => boolean) {
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const mode = useRouterFamily('needs-you-count');
  const subscribeCount = useCallback((listener: () => void) => {
    if (!workspaceId || refreshKey === undefined) return () => {};
    const lane = acquireRouterLane({ family: 'needs-you-count', workspaceId }, () => visibleRef.current?.() ?? true, listener);
    return lane.release;
  }, [workspaceId, refreshKey === undefined]);
  const snapshot = useCallback(() => {
    if (!workspaceId || mode !== 'router') return 0;
    const value = routerLaneSnapshot({ family: 'needs-you-count', workspaceId }).value as { count?: number } | null;
    return value?.count ?? 0;
  }, [mode, workspaceId]);
  const count = useSyncExternalStore(subscribeCount, snapshot, () => 0);
  return count;
}

/** Existing Forward gesture only. All other consumers attach observations. */
export function readChatList(key: ChatListKey): Promise<ChatListView> {
  if (routerFamilyMode('room-list') !== 'router')
    return Promise.reject(new Error('Room list unavailable.'));
  return new Promise((resolve, reject) => {
    let handle: ReturnType<typeof acquireRouterForwardList> | undefined;
    const finish = () => {
      if (!handle) return;
      const view = handle.current();
      if (view.state === 'PARKED') {
        handle.release();
        reject(new Error(view.error ?? 'Room list unavailable.'));
        return;
      }
      if (view.state !== 'LIVE') return;
      const value = readChatListView(view.value);
      handle.release();
      if (value) resolve(value);
      else reject(new Error('Invalid Room list.'));
    };
    handle = acquireRouterForwardList(key.workspaceId, () => true, finish);
    finish();
  });
}
