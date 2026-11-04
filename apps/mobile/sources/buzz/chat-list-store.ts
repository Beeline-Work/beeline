import { useEffect, useRef, useState } from 'react';
import equal from 'fast-deep-equal';
import type { ChatListView } from '@beeline/buzz-client';
import { useRouterFamily } from './router-family';
import { acquireChatList, liveChatList } from './server-read-owner';
import type { ChatListKey } from './server-read-owner';
export { readChatList, acquireChatList, liveChatList, chatListSnapshot, refreshChatList, resetChatListStoresForTest } from './server-read-owner';
export type { ChatListKey, ChatListConsumer, ChatListHandle } from './server-read-owner';
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
  const id = key ? JSON.stringify([key.relayUrl, key.viewerPubkey, key.workspaceId]) : null;
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
  if (mode === 'pending') return null;
  if (mode === 'router') return key ? liveChatList(key) : null;
  // Other local interactions still read the newest canonical ordering and DTO.
  return options.transcriptRoomId && key ? liveChatList(key) ?? value : value;
}
