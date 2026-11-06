import { type ChatListHandle } from '@/buzz/chat-list-store';
import { type ChatListView } from '@beeline/buzz-client';
import { useCallback, useEffect, useRef } from 'react';

type Props = [
  isDesktop: boolean,
  requestedNewRoom: string | undefined,
  handledNewRoomRequest: import("react/index").RefObject<string | null>,
  chatList: ChatListView | null,
  viewerIsAgent: boolean,
  canManageWorkspace: boolean,
  setShowCreateRoom: import("react/index").Dispatch<import("react/index").SetStateAction<boolean>>,
  requestedNewDirectMessage: string | undefined,
  setMemberPickerVisible: import("react/index").Dispatch<import("react/index").SetStateAction<boolean>>,
  readWorkspaceRef: import("react/index").RefObject<(() => Promise<void>) | null>,
  chatStore: import("react/index").RefObject<ChatListHandle | null>,
  activeCommunityId: string,
  deckMissedRef: import("react/index").RefObject<{ workspaces: boolean; }>,
];
export function useChannelsRequestedActions([
  isDesktop, requestedNewRoom, handledNewRoomRequest, chatList, viewerIsAgent, canManageWorkspace,
  setShowCreateRoom, requestedNewDirectMessage, setMemberPickerVisible, readWorkspaceRef, chatStore,
  activeCommunityId, deckMissedRef,
]: Props): [
  refreshMissed: () => void,
  refreshNow: () => void,
] {


  useEffect(() => {
    if (
      !isDesktop ||
      !requestedNewRoom ||
      requestedNewRoom === handledNewRoomRequest.current ||
      !chatList ||
      viewerIsAgent ||
      !canManageWorkspace
    ) {
      return;
    }
    handledNewRoomRequest.current = requestedNewRoom;
    setShowCreateRoom(true);
  }, [canManageWorkspace, chatList, isDesktop, requestedNewRoom, viewerIsAgent]);

  // Desktop's one door into the shared direct-message picker: the sidebar's
  // DIRECT MESSAGES `+` arrives as a one-shot route param, same pattern as
  // `newRoom` above. The picker itself (and `handleStartDirectMessage`) are
  // unchanged components.
  const handledNewDirectMessageRequest = useRef<string | null>(null);
  useEffect(() => {
    if (
      !isDesktop ||
      !requestedNewDirectMessage ||
      requestedNewDirectMessage === handledNewDirectMessageRequest.current ||
      viewerIsAgent
    ) {
      return;
    }
    handledNewDirectMessageRequest.current = requestedNewDirectMessage;
    setMemberPickerVisible(true);
  }, [isDesktop, requestedNewDirectMessage, viewerIsAgent]);

  const refreshNow = useCallback(() => {
    void readWorkspaceRef.current?.();
    chatStore.current?.force();
  }, [activeCommunityId]);

  const refreshMissed = useCallback(() => {
    if (deckMissedRef.current.workspaces) void readWorkspaceRef.current?.();
    chatStore.current?.catchUp();
    deckMissedRef.current = { workspaces: false };
  }, []);
return [
    refreshMissed, refreshNow,
  ];
}
