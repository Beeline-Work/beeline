/** Room route shell: newest-row first paint, then the deferred chrome module. */
import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type MutableRefObject,
} from 'react';
import { Platform, Text, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';
import type { RoomView } from '@beeline/buzz-client';
import { SurfaceGlyphLoader } from '@/components/buzz/SurfaceGlyphLoader';
import {
  ROOM_OPEN_COMPOSER_BOX_BORDER,
  ROOM_OPEN_COMPOSER_BOX_MIN_HEIGHT,
  ROOM_OPEN_INPUT_BAR_BORDER_TOP,
  ROOM_OPEN_INPUT_BAR_PADDING_TOP,
  ROOM_OPEN_LIST_TAIL_PADDING,
  roomOpenComposerSafePadding,
  roomOpenMessagePadding,
  roomOpenNewestTextMetrics,
} from '@/buzz/room-open-geometry';
import { afterPixelIdle } from '@/buzz/defer-interaction';
import { roomOpenPixelSeed } from '@/buzz/room-open-prefetch';
import { attachChatSurfaceAfterPaint } from './_chat-surface-load';
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

function RoomOpenPixel({
  roomSurface,
  seedText,
  onFirstPaint,
}: {
  roomSurface: RoomView | null;
  seedText: string | null;
  onFirstPaint: () => void;
}) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const newest = roomSurface?.messages.at(-1);
  const newestText = newest?.text ?? seedText;
  // Match the chat header's minHeight (insets.top + 60) so chrome mount does
  // not jump the newest row when the header appears.
  const headerReserve = insets.top + 60;
  const painted = useRef(false);
  const markLayout = (phase: 'pixel-layout-loader' | 'pixel-layout-newest') => {
    markRoomOpen(phase, newest?.id ?? (newestText ? 'seed' : undefined));
    const notify = () => {
      if (painted.current) return;
      painted.current = true;
      onFirstPaint();
    };
    const raf = globalThis.requestAnimationFrame;
    if (typeof raf === 'function') {
      raf(() => {
        markRoomOpen(phase === 'pixel-layout-newest' ? 'pixel-ui-frame' : 'pixel-ui-loader');
        notify();
      });
    } else {
      notify();
    }
  };
  if (!newestText) {
    return (
      <View
        testID="room-open-pixel"
        collapsable={false}
        onLayout={() => markLayout('pixel-layout-loader')}
        style={{
          flex: 1,
          backgroundColor: theme.buzz.bgTerminal,
          justifyContent: 'center',
          alignItems: 'center',
          paddingTop: headerReserve,
        }}
      >
        <SurfaceGlyphLoader testID="room-surface-loader" />
      </View>
    );
  }
  return (
    <View
      testID="room-open-pixel"
      collapsable={false}
      onLayout={() => markLayout('pixel-layout-newest')}
      style={{
        flex: 1,
        backgroundColor: theme.buzz.bgTerminal,
      }}
    >
      <View
        style={{
          flex: 1,
          justifyContent: 'flex-end',
          paddingTop: headerReserve,
          paddingHorizontal: ROOM_OPEN_LIST_TAIL_PADDING,
          paddingBottom: ROOM_OPEN_LIST_TAIL_PADDING + roomOpenMessagePadding(),
        }}
      >
        <Text
          testID="chat-open-pixel-newest"
          style={[roomOpenNewestTextMetrics(), { color: theme.buzz.textPrimary }]}
        >
          {newestText}
        </Text>
      </View>
      <View
        testID="room-open-pixel-composer-reserve"
        style={{
          paddingHorizontal: 16,
          paddingTop: ROOM_OPEN_INPUT_BAR_PADDING_TOP,
          borderTopWidth: ROOM_OPEN_INPUT_BAR_BORDER_TOP,
          borderTopColor: theme.buzz.bgTerminal,
          paddingBottom: roomOpenComposerSafePadding(Platform.OS, insets.bottom),
        }}
      >
        <View
          style={{
            minHeight: ROOM_OPEN_COMPOSER_BOX_MIN_HEIGHT,
            borderWidth: ROOM_OPEN_COMPOSER_BOX_BORDER,
            borderColor: theme.buzz.bgTerminal,
            borderRadius: 10,
          }}
        />
      </View>
    </View>
  );
}

/** First paint is only the newest cached/fetched row. The 6k-line chrome
 *  module is imported after that pixel and after the current interaction so
 *  a pending evaluation cannot steal the tap-to-pixel budget. */
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
  const session = useRoomSurfaceSession({
    channelId: decodedId,
    isFocused,
    ...(notificationResponseId ? { notificationResponseId } : {}),
    bindingsRef,
  });
  const [Chrome, setChrome] = useState<ComponentType<ChatSurfaceProps> | null>(null);
  const [surfaceReady, setSurfaceReady] = useState(false);
  const importCancelRef = useRef<(() => void) | null>(null);

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
  }, [session.roomSurface, Chrome, surfaceReady]);

  if (!surfaceReady || !Chrome) {
    return (
      <RoomOpenPixel
        key={decodedId}
        roomSurface={session.roomSurface}
        seedText={roomOpenPixelSeed(decodedId)}
        onFirstPaint={() => {
          if (importCancelRef.current) return;
          importCancelRef.current = attachChatSurfaceAfterPaint(
            (mod) => setChrome(() => mod.BuzzChatSurface),
            afterPixelIdle,
          );
        }}
      />
    );
  }
  return <Chrome session={session} bindingsRef={bindingsRef} />;
}
