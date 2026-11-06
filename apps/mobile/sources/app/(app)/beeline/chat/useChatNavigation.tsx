import { appErrorCopy } from '@/buzz/app-error-copy';
import React, { useEffect, useRef, useCallback } from 'react';
import { Platform } from 'react-native';
import { router } from 'expo-router';
import { Modal } from '@/modal';
import { BuzzRigTransport } from '@/sync/transport';
import { type DesktopWorkPaneEvent } from '@/buzz/desktop-workbench-state';
import { MAX_MESSAGE_ATTACHMENTS, type PickedChatAttachment } from '@/buzz/chat-attachment';
import { chatBackAction, cornerOpenAction, cornerHref, roomCornersHref, roomHref, type ChatStackRoute } from '@/buzz/corner-navigation';

type Props = [
  liveDraftStore: import("@/buzz/live-draft-drain").LiveDraftDrainStore,
  navigation: Omit<import("@react-navigation/core").NavigationProp<ReactNavigation.RootParamList>, "getState"> & { getState(): import("@react-navigation/routers").NavigationState | undefined; },
  parentChannelId: string | undefined,
  cornerReturnTarget: "corners" | "room-list" | undefined,
  transport: BuzzRigTransport | null,
  decodedId: string,
  readRoom: () => void,
  desktopExperience: boolean,
  openDesktopCorner: (roomId: string, cornerId: string) => void,
  commitDesktopWorkPane: (event: DesktopWorkPaneEvent) => import("@/buzz/desktop-workbench-state").DesktopWorkPaneTransition,
  desktopWorkRoomId: string,
  focusComposer: () => void,
  profileAgentId: string | null,
  setProfileAgentId: React.Dispatch<React.SetStateAction<string | null>>,
  desktopWorkPaneMounted: import("@beeline/api-contract/phone").RoomView | null,
  sending: boolean,
  pendingAttachments: PickedChatAttachment[],
  replacePendingAttachments: (update: PickedChatAttachment[] | ((current: PickedChatAttachment[]) => PickedChatAttachment[])) => void,
];

export function useChatNavigation([
  liveDraftStore, navigation, parentChannelId, cornerReturnTarget, transport, decodedId, readRoom,
  desktopExperience, openDesktopCorner, commitDesktopWorkPane, desktopWorkRoomId, focusComposer,
  profileAgentId, setProfileAgentId, desktopWorkPaneMounted, sending, pendingAttachments,
  replacePendingAttachments,
]: Props): [
  handleCloseCorner: () => Promise<void>,
  openCorner: (subchannelId: string | undefined) => void,
  handleBack: () => void,
  handleCommunitySelect: (communityId: string | null) => void,
  handleDesktopDrop: (event: React.DragEvent<HTMLElement>) => void,
  handleDesktopPaste: (event: ClipboardEvent) => void,
  expandDesktopCorner: (cornerId: string) => void,
  closeDesktopWorkPane: () => void,
] {


  /**
   * Leave this transcript. A screen opened from a notification or a list
   * returns to that list; otherwise it pops to the screen it was opened from.
   * See `corner-navigation.ts`. A lone transcript replaces itself instead of
   * calling a `router.back()` that silently does nothing.
   */
  const handleBack = useCallback(() => {
    // Stop the live-draft drain before the stack moves. The scheduler otherwise
    // keeps ticking on a still-mounted Room (native-stack does not unmount on
    // blur) and a back press waits until the turn's text is ready to paint.
    liveDraftStore.setActive(false);
    const routes = (navigation.getState()?.routes ?? []) as ChatStackRoute[];
    const action = chatBackAction(routes, parentChannelId, cornerReturnTarget);
    if (action.type === 'pop') router.dismiss(action.count);
    // A lone corner (for example, an older link without an origin hint) has
    // nothing to pop to, so open its parent Room.
    else if (action.type === 'open-room') router.replace(roomHref(action.channelId));
    // A corner opened from a Room's corners screen lands back on that screen
    // even when the list is not on the stack — never the parent Room.
    else if (action.type === 'open-corners') router.replace(roomCornersHref(action.roomId));
    else if (action.type === 'back') router.back();
    else router.replace('/beeline/channels');
  }, [cornerReturnTarget, liveDraftStore, navigation, parentChannelId]);


  const closeCornerPending = useRef(false);

  const handleCloseCorner = useCallback(async () => {
    if (closeCornerPending.current) return;
    closeCornerPending.current = true;
    try {
      if (!transport) throw new Error('Still connecting. Try again in a moment.');
      await transport.closeCorner(decodedId);
      handleBack();
    } catch (error) {
      readRoom();
      Modal.alert('Could not close corner', appErrorCopy(error));
    } finally {
      closeCornerPending.current = false;
    }
  }, [decodedId, handleBack, transport, readRoom]);


  const handleCommunitySelect = useCallback((communityId: string | null) => {
    if (!communityId) return;
    router.replace({
      pathname: '/beeline/channels',
      params: { communityId },
    });
  }, []);


  const openCorner = useCallback(
    (subchannelId: string | undefined) => {
      const action = cornerOpenAction(subchannelId, decodedId);
      if (action.type === 'explain') {
        Modal.alert('Corner unavailable', action.message);
        return;
      }
      if (desktopExperience) openDesktopCorner(decodedId, action.cornerId);
      else router.push(cornerHref(action.cornerId, decodedId));
    },
    [decodedId, desktopExperience, openDesktopCorner],
  );


  const closeDesktopWorkPane = useCallback(() => {
    commitDesktopWorkPane({ type: 'close' });
  }, [commitDesktopWorkPane]);


  // Expand moves the corner into the primary view and closes the pane.
  const expandDesktopCorner = useCallback(
    (cornerId: string) => {
      commitDesktopWorkPane({ type: 'expand' });
      router.push(cornerHref(cornerId, desktopWorkRoomId));
    },
    [commitDesktopWorkPane, desktopWorkRoomId],
  );


  useEffect(() => {
    if (!desktopExperience || Platform.OS !== 'web' || typeof window === 'undefined') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === 'm'
      ) {
        event.preventDefault();
        focusComposer();
      } else if (event.key === 'Escape' && profileAgentId) {
        event.preventDefault();
        setProfileAgentId(null);
      } else if (event.key === 'Escape' && desktopWorkPaneMounted) {
        event.preventDefault();
        closeDesktopWorkPane();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    closeDesktopWorkPane,
    desktopExperience,
    desktopWorkPaneMounted,
    focusComposer,
    profileAgentId,
  ]);


  const handleDesktopDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!desktopExperience || sending) return;
      event.preventDefault();
      const files = Array.from(event.dataTransfer.files).slice(
        0,
        MAX_MESSAGE_ATTACHMENTS - pendingAttachments.length,
      );
      if (!files.length) return;
      replacePendingAttachments((current) => [
        ...current,
        ...files.map((file) => ({
          uri: URL.createObjectURL(file),
          name: file.name || `file-${Date.now()}`,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          source: 'file' as const,
        })),
      ]);
    },
    [desktopExperience, pendingAttachments.length, replacePendingAttachments, sending],
  );


  const handleDesktopPaste = useCallback(
    (event: ClipboardEvent) => {
      if (!desktopExperience || sending) return;
      const files = Array.from(event.clipboardData?.files ?? []).slice(
        0,
        MAX_MESSAGE_ATTACHMENTS - pendingAttachments.length,
      );
      if (!files.length) return;
      event.preventDefault();
      replacePendingAttachments((current) => [
        ...current,
        ...files.map((file) => ({
          uri: URL.createObjectURL(file),
          name: file.name || `clipboard-${Date.now()}`,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          source: 'file' as const,
        })),
      ]);
    },
    [desktopExperience, pendingAttachments.length, replacePendingAttachments, sending],
  );
  return [
    handleCloseCorner, openCorner, handleBack, handleCommunitySelect, handleDesktopDrop,
    handleDesktopPaste, expandDesktopCorner, closeDesktopWorkPane,
  ];
}
