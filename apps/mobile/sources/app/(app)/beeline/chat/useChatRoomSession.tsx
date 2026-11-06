import { setArtifactViewportActive } from '@/buzz/artifact-viewport';
import { appErrorCopy } from '@/buzz/app-error-copy';
import React, { useEffect, useLayoutEffect, useState, useCallback } from 'react';
import { Platform, AppState } from 'react-native';
import * as Notifications from 'expo-notifications';
import { useFocusEffect } from 'expo-router';
import { sharedLiveConnection } from '@/sync/transport/live-connection';
import { BuzzRigTransport } from '@/sync/transport';
import { type ChatDisplayMessage } from '@/buzz/room-view-presentation';
import { pushOpenBuzzChannelId, releaseOpenBuzzChannelId } from '@/buzz/open-room-tracker';
import { dismissPresentedNotificationsForChannel } from '@/push/presented-notifications';
import { markRoomOpen, type UseRoomSurfaceSessionResult } from './useRoomSurfaceSession';
import { monolithPhoneOperation } from '@/sync/transport/monolith-operation';

type Props = [
  decodedId: string,
  readSetMembershipError: () => React.Dispatch<React.SetStateAction<string | null>>,
  navigation: Omit<import("@react-navigation/core").NavigationProp<ReactNavigation.RootParamList>, "getState"> & { getState(): import("@react-navigation/routers").NavigationState | undefined; },
  session: UseRoomSurfaceSessionResult,
];

export function useChatRoomSession([
  decodedId, readSetMembershipError, navigation, session,
]: Props): [
  userPubkey: string,
  outbox: import("@/app/(app)/beeline/chat/useRoomSurfaceSession").RoomSurfaceOutboxHandle,
  transport: BuzzRigTransport | null,
  roomSurface: import("@beeline/api-contract/phone").RoomView | null,
  roomClient: import("@/sync/transport/room-view-client").RoomViewClient | null,
  firstUnreadMessageId: string | null,
  isFocused: () => boolean,
  messageRecordScope: string | null,
  liveOverlays: readonly import("@beeline/buzz-client").LiveOverlay[],
  heartbeatPresences: Record<string, import("@/buzz/agent-presence").RoomAgentPresence>,
  presenceNow: number,
  presenceReconnectGrace: Record<string, number>,
  setSessionTransport: (transport: BuzzRigTransport) => void,
  advanceReadCursor: (chronological: readonly ChatDisplayMessage[], visible: readonly ChatDisplayMessage[]) => void,
  liveDraftStore: import("@/buzz/live-draft-drain").LiveDraftDrainStore,
  readRoom: () => void,
  setPresenceNow: (now: number) => void,
  applyRoomMessageResult: (message: import("@beeline/api-contract/phone").RoomViewMessage) => void,
  applyPendingAgentCommands: (commands: NonNullable<import("@beeline/api-contract/phone").RoomView["pendingAgentCommands"]>) => void,
  acknowledgeReadMark: (messageId: string) => void,
  applyRoomRepositoryResult: (result: import("@beeline/api-contract/phone").RoomRepositoryResult) => void,
  applyRoomName: (name: string, expected?: string) => void,
  clearRoomRepository: () => void,
  transcriptHydrationFailed: boolean,
  transcriptHydrationError: string | null,
  retryHydration: () => void,
  applyRoomReviewer: (reviewerAgentId: string | undefined) => void,
  pushMuteWorking: boolean,
  togglePushMute: () => Promise<void>,
  pushMuted: boolean,
] {


  // Publish the open conversation to the foreground notification policy. The
  // root notification handler runs outside the React tree, so it reads this
  // tracker instead of route state. Synchronous, no relay work.
  const [pushMuted, setPushMuted] = useState(false);
  const [pushMuteWorking, setPushMuteWorking] = useState(false);
  const togglePushMute = async () => {
    if (pushMuteWorking) return;
    const previous = pushMuted;
    setPushMuteWorking(true);
    setPushMuted(!previous);
    try {
      const result = await monolithPhoneOperation('updateRoomPushState', {
        roomId: decodedId,
        muted: !previous,
      });
      setPushMuted(result.muted);
    } catch (error) {
      setPushMuted(previous);
      readSetMembershipError()(appErrorCopy(error, `Could not update notifications.`));
    } finally {
      setPushMuteWorking(false);
    }
  };
  const isFocused = useCallback(() => navigation.isFocused(), [navigation]);
  useFocusEffect(
    useCallback(() => {
      pushOpenBuzzChannelId(decodedId || null);
      // The live socket tells the server this Room is on screen, once on
      // arrival and once on leaving; the server ends the view when the
      // socket closes, so nothing repeats while the reader stays here.
      let releaseView: (() => void) | undefined;
      const updateViewing = (viewing: boolean) => {
        if (!decodedId) return;
        setArtifactViewportActive(decodedId, viewing);
        if (viewing) releaseView ??= sharedLiveConnection().view(decodedId);
        else {
          releaseView?.();
          releaseView = undefined;
        }
      };
      updateViewing(AppState.currentState === 'active');
      const viewingState = AppState.addEventListener('change', (state) =>
        updateViewing(state === 'active'),
      );
      const dismiss = () => {
        if (AppState.currentState !== 'active') return;
        void dismissPresentedNotificationsForChannel(decodedId, Notifications, Platform.OS).catch(
          (error) => {
            console.log('Failed to dismiss notifications for opened conversation:', error);
          },
        );
      };
      dismiss();
      const appState = AppState.addEventListener('change', dismiss);
      const received = Notifications.addNotificationReceivedListener(dismiss);
      return () => {
        viewingState.remove();
        updateViewing(false);
        releaseOpenBuzzChannelId(decodedId || null);
        appState.remove();
        received.remove();
      };
    }, [decodedId]),
  );

  const {
    transport,
    adoptTransport: setSessionTransport,
    roomClient,
    roomSurface,
    messageRecordScope,
    applyRoomRepositoryResult,
    clearRoomRepository,
    applyRoomMessageResult,
    applyPendingAgentCommands,
    applyRoomName,
    applyRoomReviewer,
    firstUnreadMessageId,
    advanceReadCursor,
    acknowledgeReadMark,
    liveOverlays,
    liveDraftStore,
    userPubkey,
    heartbeatPresences,
    presenceReconnectGrace,
    presenceNow,
    setPresenceNow,
    hydrationFailed: transcriptHydrationFailed,
    hydrationError: transcriptHydrationError,
    retryHydration,
    readRoom,
    outbox,
  } = session;
  useEffect(() => {
    return navigation.addListener('beforeRemove', () => {
      liveDraftStore.setActive(false);
    });
  }, [liveDraftStore, navigation]);
  useLayoutEffect(() => {
    if (!roomSurface) return;
    markRoomOpen('layout-chrome', roomSurface.messages.at(-1)?.id);
  }, [roomSurface]);
  // The Room read carries the viewer's mute; a toggle answers with its own.
  const hasRoomSurface = roomSurface !== null;
  const viewerPushMuted = roomSurface?.viewer.pushMuted === true;
  useEffect(() => {
    if (hasRoomSurface) setPushMuted(viewerPushMuted);
  }, [hasRoomSurface, viewerPushMuted]);
  return [
    userPubkey, outbox, transport, roomSurface, roomClient, firstUnreadMessageId, isFocused,
    messageRecordScope, liveOverlays, heartbeatPresences, presenceNow, presenceReconnectGrace,
    setSessionTransport, advanceReadCursor, liveDraftStore, readRoom, setPresenceNow,
    applyRoomMessageResult, applyPendingAgentCommands, acknowledgeReadMark,
    applyRoomRepositoryResult, applyRoomName, clearRoomRepository, transcriptHydrationFailed,
    transcriptHydrationError, retryHydration, applyRoomReviewer, pushMuteWorking, togglePushMute,
    pushMuted,
  ];
}
