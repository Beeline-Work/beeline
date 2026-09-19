/** Room route shell: newest-row first paint, then the deferred chrome module. */
import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type MutableRefObject,
} from 'react';
import { useIsFocused } from '@react-navigation/native';
import { useLocalSearchParams } from 'expo-router';
import { afterPixelIdle } from '@/buzz/defer-interaction';
import { roomOpenPixelSnapshot } from '@/buzz/room-open-prefetch';
import { attachChatSurfaceAfterPaint } from './_chat-surface-load';
import { RoomOpenPixel } from './_room-open-pixel';
import {
  markRoomOpen,
  useRoomSurfaceSession,
  type RoomSurfaceSessionBindings,
  type UseRoomSurfaceSessionResult,
} from './useRoomSurfaceSession';

type ChatSurfaceProps = {
  session: UseRoomSurfaceSessionResult;
  bindingsRef: MutableRefObject<RoomSurfaceSessionBindings>;
};

/** First paint is only the newest seeded row. Session hooks and the 6k chrome
 *  module start after that pixel so they cannot steal the tap-to-pixel budget. */
export default function BuzzChat() {
  const { channelId, notificationResponseId } = useLocalSearchParams<{
    channelId: string;
    notificationResponseId?: string;
  }>();
  const decodedId = channelId ? decodeURIComponent(channelId) : '';
  const [sessionOn, setSessionOn] = useState(false);
  const [Chrome, setChrome] = useState<ComponentType<ChatSurfaceProps> | null>(null);
  const [surfaceReady, setSurfaceReady] = useState(false);
  const importCancelRef = useRef<(() => void) | null>(null);
  const pixelSeed = roomOpenPixelSnapshot(decodedId);

  useLayoutEffect(() => {
    markRoomOpen('route-mount', decodedId);
    setSurfaceReady(false);
    importCancelRef.current?.();
    importCancelRef.current = null;
  }, [decodedId]);

  useEffect(() => {
    return () => {
      importCancelRef.current?.();
      importCancelRef.current = null;
    };
  }, []);

  const showPixel = !surfaceReady || !Chrome;
  return (
    <>
      {showPixel ? (
        <RoomOpenPixel
          key={decodedId}
          roomSurface={null}
          seedText={pixelSeed?.text ?? null}
          agentsOffline={pixelSeed?.agentsOffline}
          onFirstPaint={() => {
            if (importCancelRef.current) return;
            importCancelRef.current = attachChatSurfaceAfterPaint(
              (mod) => setChrome(() => mod.BuzzChatSurface),
              afterPixelIdle,
            );
            afterPixelIdle(() => setSessionOn(true));
          }}
        />
      ) : null}
      {sessionOn ? (
        <RoomSessionHost
          decodedId={decodedId}
          notificationResponseId={notificationResponseId}
          Chrome={Chrome}
          surfaceReady={surfaceReady}
          setSurfaceReady={setSurfaceReady}
        />
      ) : null}
    </>
  );
}

function RoomSessionHost({
  decodedId,
  notificationResponseId,
  Chrome,
  surfaceReady,
  setSurfaceReady,
}: {
  decodedId: string;
  notificationResponseId?: string;
  Chrome: ComponentType<ChatSurfaceProps> | null;
  surfaceReady: boolean;
  setSurfaceReady: (ready: boolean) => void;
}) {
  const isFocused = useIsFocused();
  const bindingsRef = useRef<RoomSurfaceSessionBindings>({
    resetTranscript: () => undefined,
    restoreOutboxMessages: () => undefined,
    dismissOptimisticMessage: () => undefined,
    observeRoomSurface: () => undefined,
  });
  const session = useRoomSurfaceSession({
    channelId: decodedId,
    isFocused,
    ...(notificationResponseId ? { notificationResponseId } : {}),
    bindingsRef,
  });

  useLayoutEffect(() => {
    if (!session.roomSurface) return;
    markRoomOpen('layout-surface', session.roomSurface.messages.at(-1)?.id);
  }, [session.roomSurface]);

  useEffect(() => {
    if (!session.roomSurface || !Chrome || surfaceReady) return;
    const raf = globalThis.requestAnimationFrame;
    if (typeof raf !== 'function') {
      setSurfaceReady(true);
      return;
    }
    let second = 0;
    const first = raf(() => {
      second = raf(() => setSurfaceReady(true));
    });
    return () => {
      const cancel = globalThis.cancelAnimationFrame;
      if (typeof cancel === 'function') {
        cancel(first);
        if (second) cancel(second);
      }
    };
  }, [session.roomSurface, Chrome, surfaceReady, setSurfaceReady]);

  if (!surfaceReady || !Chrome) return null;
  return <Chrome session={session} bindingsRef={bindingsRef} />;
}
