/** Newest-row first paint for Room open. Shared by the deck overlay and the route. */
import React, { useRef } from 'react';
import { Platform, Text, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
import { markRoomOpen } from '@/buzz/room-open-trace';

export function RoomOpenPixel({
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
