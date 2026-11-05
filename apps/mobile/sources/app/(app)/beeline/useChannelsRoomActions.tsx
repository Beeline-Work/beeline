import { appErrorCopy } from '@/buzz/app-error-copy';
import { type ChatListHandle } from '@/buzz/chat-list-store';
import { roomRowName } from '@/buzz/room-list-row';
import { useRoomListGestures } from '@/buzz/use-room-list-gestures';
import { leaveRoomWithConfirmation } from '@/buzz/room-leave';
import { ROOM_LABEL } from '@/buzz/vocabulary';
import { Modal } from '@/modal';
import { BuzzRigTransport } from '@/sync/transport';
import { type ChatListItem } from '@beeline/buzz-client';
import * as Haptics from 'expo-haptics';
import { useCallback, useRef } from 'react';
import { Swipeable } from 'react-native-gesture-handler';

type Props = [
  transport: BuzzRigTransport,
  chatStore: import("react/index").RefObject<ChatListHandle | null>,
  setError: import("react/index").Dispatch<import("react/index").SetStateAction<string | null>>,
];
export function useChannelsRoomActions([
  transport, chatStore, setError,
]: Props): [
  roomListGestures: { swipesEnabled: boolean; canInteract: () => boolean; touchHandlers: { onStartShouldSetResponderCapture: () => false; onTouchEnd: () => void; onTouchCancel: () => void; }; listHandlers: { onScrollBeginDrag: () => void; onScrollEndDrag: (event: import("react-native").NativeSyntheticEvent<import("react-native").NativeScrollEvent>) => void; onMomentumScrollBegin: () => void; onMomentumScrollEnd: () => void; }; },
  swipeableRefs: import("react/index").RefObject<Map<string, Swipeable | null>>,
  handleLeaveRoom: (item: ChatListItem) => Promise<void>,
  handleCloseChat: (item: ChatListItem) => Promise<void>,
] {


  const swipeableRefs = useRef<Map<string, Swipeable | null>>(new Map());
  const roomListGestures = useRoomListGestures();

  const handleCloseChat = useCallback(
    async (item: ChatListItem) => {
      swipeableRefs.current.get(item.room.id)?.close();
      if (!transport) {
        Modal.alert('Cannot close yet', 'Connection is still starting. Try again.');
        return;
      }
      try {
        await transport.closeChat(item.room.id);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        chatStore.current?.force();
      } catch (reason) {
        setError(appErrorCopy(reason, `Could not close chat.`));
      }
    },
    [transport],
  );

  const handleLeaveRoom = useCallback(
    async (item: ChatListItem) => {
      swipeableRefs.current.get(item.room.id)?.close();
      if (!transport) {
        Modal.alert('Cannot leave yet', 'Connection is still starting. Try again.');
        return;
      }
      const heading = roomRowName(item);
      const title = `${heading.sigil}${heading.name}`;
      try {
        const left = await leaveRoomWithConfirmation(
          title,
          item.leaveDeletesRoom === true,
          (confirmDelete) => transport.leaveRoom(item.room.id, confirmDelete),
        );
        if (!left) return;
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        chatStore.current?.force();
      } catch (reason) {
        setError(appErrorCopy(reason, `Could not leave ${ROOM_LABEL}.`));
      }
    },
    [transport],
  );
return [
    roomListGestures, swipeableRefs, handleLeaveRoom, handleCloseChat,
  ];
}
