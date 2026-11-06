import { appErrorCopy } from '@/buzz/app-error-copy';
import { useScopedCallbacks } from '@/buzz/use-stable';
import { saveActiveCommunityId, saveLastViewedChannel } from '@/buzz/community-storage';
import { cornerHref, navigateToRoom } from '@/buzz/corner-navigation';
import { openRoomListCorner } from '@/buzz/room-list-new-corner';
import { cornerOpenTappedAgain } from '@/buzz/corner-open-status';
import type { CornerOpenAttempt } from '@/buzz/open-random-corner';
import { dispatchRoomOpenTap } from '@/buzz/room-open-prefetch';
import { type WorkspaceMemberDisplayItem } from '@/buzz/room-view-presentation';
import { BuzzRigTransport } from '@/sync/transport';
import { type Identity } from '@beeline/buzz-client';
import { router } from 'expo-router';
import { useCallback, useRef } from 'react';
import { Swipeable } from 'react-native-gesture-handler';

type Props = [
  identity: Identity,
  activeCommunityId: string,
  transport: BuzzRigTransport,
  roomListGestures: { swipesEnabled: boolean; canInteract: () => boolean; touchHandlers: { onStartShouldSetResponderCapture: () => false; onTouchEnd: () => void; onTouchCancel: () => void; }; listHandlers: { onScrollBeginDrag: () => void; onScrollEndDrag: (event: import("react-native").NativeSyntheticEvent<import("react-native").NativeScrollEvent>) => void; onMomentumScrollBegin: () => void; onMomentumScrollEnd: () => void; }; },
  swipeableRefs: import("react/index").RefObject<Map<string, Swipeable | null>>,
  togglePin: (id: string) => Promise<void>,
  cornerDropdowns: { expanded: ReadonlySet<string>; setExpanded: import("react/index").Dispatch<import("react/index").SetStateAction<ReadonlySet<string>>>; toggle: (roomId: string) => void; },
  messagingPubkey: string | null,
  setMessagingPubkey: import("react/index").Dispatch<import("react/index").SetStateAction<string | null>>,
  setMemberPickerVisible: import("react/index").Dispatch<import("react/index").SetStateAction<boolean>>,
  setError: import("react/index").Dispatch<import("react/index").SetStateAction<string | null>>,
];
export function useChannelsNavigation([
  identity, activeCommunityId, transport, roomListGestures, swipeableRefs, togglePin,
  cornerDropdowns, messagingPubkey, setMessagingPubkey, setMemberPickerVisible, setError,
]: Props): [
  selectWorkspace: (workspaceId: string | null) => void,
  rowActions: { press: (roomId: string) => void; pin: (roomId: string) => void; toggleCorners: (roomId: string) => void; newCorner: (roomId: string) => void; },
  handleStartDirectMessage: (member: WorkspaceMemberDisplayItem) => Promise<void>,
] {


  const openRoom = useCallback(
    (roomId: string) => {
      dispatchRoomOpenTap(roomId, {
        navigate: (id) => {
          if (identity) void saveLastViewedChannel(identity.publicKey, activeCommunityId, id);
          navigateToRoom(router, id);
        },
      });
    },
    [activeCommunityId, identity],
  );

  const openingCornerRef = useRef(false);
  const openNewCorner = useCallback(
    async (roomId: string, attempt?: CornerOpenAttempt) => {
      if (openingCornerRef.current) return cornerOpenTappedAgain();
      openingCornerRef.current = true;
      try {
        await openRoomListCorner({
          roomId,
          attempt,
          createCorner: transport
            ? (id, title, cornerId) =>
                transport.createHumanCorner(id, title, undefined, true, cornerId)
            : null,
          openCorner: (cornerId, title) =>
            router.push(cornerHref(cornerId, roomId, title, 'room-list')),
          retry: (failed) => void openNewCorner(roomId, failed),
        });
      } finally {
        openingCornerRef.current = false;
      }
    },
    [transport],
  );

  // A list update changes one DTO, not every Room's event handlers.
  const rowActions = useScopedCallbacks(
    {
      press: (roomId: string) => {
        if (!roomListGestures.canInteract()) return;
        swipeableRefs.current.get(roomId)?.close();
        openRoom(roomId);
      },
      pin: (roomId: string) => {
        if (roomListGestures.canInteract()) void togglePin(roomId);
      },
      toggleCorners: (roomId: string) => {
        if (roomListGestures.canInteract()) cornerDropdowns.toggle(roomId);
      },
      newCorner: (roomId: string) => {
        if (roomListGestures.canInteract()) void openNewCorner(roomId);
      },
    },
    `${identity?.publicKey ?? ''}:${activeCommunityId ?? ''}`,
  );

  const selectWorkspace = useCallback(
    (workspaceId: string | null) => {
      if (!workspaceId) return;
      if (identity) void saveActiveCommunityId(identity.publicKey, workspaceId);
      router.replace({ pathname: '/beeline/channels', params: { communityId: workspaceId } });
    },
    [identity],
  );

  const handleStartDirectMessage = useCallback(
    async (member: WorkspaceMemberDisplayItem) => {
      if (!transport || !activeCommunityId || messagingPubkey) return;
      setMessagingPubkey(member.peerPubkey);
      try {
        const room = await transport.resolveDirectMessage(activeCommunityId, member.peerPubkey);
        setMemberPickerVisible(false);
        openRoom(room.channelId);
      } catch (reason) {
        setError(appErrorCopy(reason));
      } finally {
        setMessagingPubkey(null);
      }
    },
    [activeCommunityId, messagingPubkey, openRoom, transport],
  );
return [
    selectWorkspace, rowActions, handleStartDirectMessage,
  ];
}
