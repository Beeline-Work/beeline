/** Room route: header, transcript, and composer are the open, not a last-message pixel. */
import React, { memo, useLayoutEffect, useRef } from 'react';
import { useIsFocused, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { ParamListBase } from '@react-navigation/native';
import { roomTransitionWork } from '@/buzz/room-transition-work';
import { useLocalSearchParams } from 'expo-router';
import { markRoomOpen } from '@/buzz/room-open-trace';
import { abandonRoomDraw, roomDrawGeneration } from '@/buzz/room-draw-barrier';
import { RoomOpenTraceOverlay } from '@/components/buzz/RoomOpenTraceOverlay';
import { BuzzChatSurface } from './_chat-surface';
import {
  useRoomSurfaceSession,
  type RoomSurfaceSessionBindings,
} from './useRoomSurfaceSession';

const RoomSurface = memo(BuzzChatSurface, (previous, next) =>
  previous.bindingsRef === next.bindingsRef &&
  (Object.keys(previous.session) as Array<keyof typeof previous.session>).every(
    (key) => Object.is(previous.session[key], next.session[key]),
  ));

export default function BuzzChat() {
  const { channelId, notificationResponseId } = useLocalSearchParams<{
    channelId: string;
    notificationResponseId?: string;
  }>();
  const decodedId = channelId ? decodeURIComponent(channelId) : '';
  const isFocused = useIsFocused();
  const navigation = useNavigation<NativeStackNavigationProp<ParamListBase>>();
  useLayoutEffect(() => {
    let finish: (() => void) | undefined;
    const start = navigation.addListener('transitionStart', () => {
      finish ??= roomTransitionWork.begin();
    });
    const end = navigation.addListener('transitionEnd', () => { finish?.(); finish = undefined; });
    return () => { start(); end(); finish?.(); };
  }, [navigation]);
  const bindingsRef = useRef<RoomSurfaceSessionBindings>({
    resetTranscript: () => undefined,
    restoreOutboxMessages: () => undefined,
    dismissOptimisticMessage: () => undefined,
    observeRoomSurface: () => undefined,
  });

  useLayoutEffect(() => {
    if (!isFocused || !decodedId) return;
    markRoomOpen('route-mount', decodedId);
    const visit = roomDrawGeneration();
    return () => abandonRoomDraw(visit);
  }, [decodedId, isFocused]);

  const session = useRoomSurfaceSession({
    channelId: decodedId,
    isFocused,
    ...(notificationResponseId ? { notificationResponseId } : {}),
    bindingsRef,
  });

  return (
    <>
      <RoomSurface session={session} bindingsRef={bindingsRef} />
      <RoomOpenTraceOverlay />
    </>
  );
}
