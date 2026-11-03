import { useEffect, useRef, useState } from 'react';
import equal from 'fast-deep-equal';
import { isChatListView, type ChatListView } from '@beeline/buzz-client';
import { resetClientState } from '@/sync/client-reset';
import { useRouterFamily } from './router-family';
import { acquireRoutedChatList } from './router-chat-list';
import { routerFamilyMode, routerLaneSnapshot } from './router-owner';

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

const idOf = (key: ChatListKey) => JSON.stringify([key.relayUrl, key.viewerPubkey, key.workspaceId]);
export function acquireChatList(key: ChatListKey, consumer: ChatListConsumer): ChatListHandle {
  return acquireRoutedChatList(key, consumer);
}
export function liveChatList(key: ChatListKey): ChatListView | null {
  if (routerFamilyMode('room-list') !== 'router') return null;
  const view = routerLaneSnapshot({ family: 'room-list', workspaceId: key.workspaceId });
  return view.state === 'LIVE' && isChatListView(view.value) ? view.value : null;
}
export const chatListSnapshot = liveChatList;
/** Transcript headers, mentions and forwarding do not display deck previews. */
function sameTranscriptContext(before: ChatListView | null, after: ChatListView | null, roomId: string): boolean {
  if (before === after) return true;
  if (!before || !after || before.chats.length !== after.chats.length ||
      !equal(before.workspace, after.workspace) || !equal(before.viewer, after.viewer)) return false;
  const byId = new Map(after.chats.map((item) => [item.room.id, item]));
  return before.chats.every((item) => {
    const next = byId.get(item.room.id);
    return next !== undefined && equal(item.room, next.room) &&
      item.repositoryName === next.repositoryName && equal(item.directMessage, next.directMessage) &&
      (item.room.id !== roomId ||
        (item.agentState === next.agentState && equal(item.voiceCall, next.voiceCall)));
  });
}

export type UseChatListOptions = { readonly visible?: () => boolean; readonly onError?: (reason: unknown) => void;
  readonly transcriptRoomId?: string };
export function useChatList(key: ChatListKey | null, options: UseChatListOptions = {}): ChatListView | null {
  const mode = useRouterFamily('room-list');
  const [value, setValue] = useState<ChatListView | null>(null);
  const painted = useRef<ChatListView | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const id = key ? idOf(key) : null;
  useEffect(() => {
    if (!key) { painted.current = null; setValue(null); return; }
    const handle = acquireChatList(key, {
      visible: () => optionsRef.current.visible?.() ?? true,
      onError: (reason) => optionsRef.current.onError?.(reason),
    });
    const paint = () => {
      const next = handle.current();
      const roomId = optionsRef.current.transcriptRoomId;
      if (roomId && sameTranscriptContext(painted.current, next, roomId)) return;
      painted.current = next;
      setValue(next);
    };
    paint();
    const stop = handle.subscribe(paint);
    handle.catchUp();
    return () => { stop(); handle.release(); };
  }, [id]);
  // A retained sidebar cannot expose its prior private projection while a
  // replacement connection has not negotiated and reauthorized its family.
  if (mode !== 'router') return null;
  return options.transcriptRoomId ? value : key ? liveChatList(key) : null;
}
export const resetChatListStoresForTest = resetClientState;
