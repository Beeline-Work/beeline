/** Room route: header, transcript, and composer are the open, not a last-message pixel. */
import React, { useLayoutEffect, useRef } from 'react';
import { useIsFocused } from '@react-navigation/native';
import { useLocalSearchParams } from 'expo-router';
import { markRoomOpen } from '@/buzz/room-open-trace';
import { RoomOpenTraceOverlay } from '@/components/buzz/RoomOpenTraceOverlay';
import { BuzzChatSurface } from './_chat-surface';
import {
  useRoomSurfaceSession,
  type RoomSurfaceSessionBindings,
} from './useRoomSurfaceSession';

export default function BuzzChat() {
  const { channelId, notificationResponseId } = useLocalSearchParams<{
    channelId: string;
    notificationResponseId?: string;
  }>();
  const decodedId = channelId ? decodeURIComponent(channelId) : '';
  const isFocused = useIsFocused();
  const bindingsRef = useRef<RoomSurfaceSessionBindings>({
    resetTranscript: () => undefined,
    restoreOutboxMessages: () => undefined,
    dismissOptimisticMessage: () => undefined,
    observeRoomSurface: () => undefined,
  });

  useLayoutEffect(() => {
    markRoomOpen('route-mount', decodedId);
  }, [decodedId]);

  const session = useRoomSurfaceSession({
    channelId: decodedId,
    isFocused,
    ...(notificationResponseId ? { notificationResponseId } : {}),
    bindingsRef,
  });

  return (
    <>
      <BuzzChatSurface session={session} bindingsRef={bindingsRef} />
      <RoomOpenTraceOverlay />
    </>
  );
}
