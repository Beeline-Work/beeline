import type { ChatListView } from '@beeline/buzz-client';
export { ChatReads } from './server-read-owner-chat-reads';

export { acquireChatList, liveChatList, chatListSnapshot, refreshChatList, resetChatListStoresForTest, loadNeedsYouList, loadSavedList, loadTrayList, seedNeedsYouList, forgetTray, removeNeedsYou, holdNeedsYou, subscribeTrayGap, useTrayList, useNeedsYouCount, acknowledgePaintedNeedsYou, hideSavedItems, revealSavedItems, readChatList } from './server-read-owner-tray-reads';




export type ChatListKey = {
  readonly relayUrl: string;
  readonly viewerPubkey: string;
  readonly workspaceId: string;
};


export type ChatListConsumer = {
  readonly visible: () => boolean;
  readonly onRead?: () => void;
  readonly onError?: (reason: unknown) => void;
};


export interface ChatListHandle {
  current(): ChatListView | null;
  confirmed(): boolean;
  subscribe(listener: () => void): () => void;
  force(): void;
  catchUp(): void;
  release(): void;
  remove(): Promise<void>;
}
