import React, { useEffect, useState } from 'react';
import { TouchableOpacity, View } from 'react-native';
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { StyleSheet } from 'react-native-unistyles';
import Svg, { Circle, Path, Polygon, Rect } from 'react-native-svg';
import brand from '@/buzz/brand.json';
import {
  HullActionSheetCancel,
  HullActionSheetModal,
  HullActionSheetRow,
} from '@/components/buzz/HullActionSheet';
import { RoomGlyph } from '@/components/buzz/RoomGlyph';
import { Typography } from '@/constants/Typography';

export type RoomDeckComposeAction = 'message' | 'room' | 'invite' | 'agent' | 'join';

type RoomDeckComposeMenuProps = {
  onSelect: (action: RoomDeckComposeAction) => void;
};

type ComposeOption = {
  action: RoomDeckComposeAction;
  label: string;
  description: string;
};

const COMPOSE_OPTIONS: readonly ComposeOption[] = [
  { action: 'message', label: 'Message', description: 'Direct message a person' },
  { action: 'room', label: 'Room', description: 'New room in this workspace' },
  { action: 'invite', label: 'Invite', description: 'Bring a person into the workspace' },
  { action: 'agent', label: 'Agent', description: 'Seat an agent here' },
  { action: 'join', label: 'Join', description: 'Paste a Workspace invite' },
] as const;

const GLYPH_ROTATION_MS = 180;
const GLYPH_SIZE = 24;
const GLYPH_STROKE_WIDTH = 1.25;
const FAB_GLYPH_SIZE = 24;
const FAB_GLYPH_STROKE_WIDTH = 1.5;

/**
 * Flat hull compose affordance for the Room deck. The brass plus rotates into
 * a close mark while the shared bottom Hull sheet owns the floating actions.
 */
export function RoomDeckComposeMenu({ onSelect }: RoomDeckComposeMenuProps) {
  const [open, setOpen] = useState(false);
  const rotation = useSharedValue(0);

  useEffect(() => {
    rotation.value = withTiming(open ? 1 : 0, {
      duration: GLYPH_ROTATION_MS,
      easing: Easing.out(Easing.cubic),
      reduceMotion: ReduceMotion.System,
    });
  }, [open, rotation]);

  const glyphStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${rotation.value * 45}deg` }],
  }));
  const close = () => setOpen(false);
  const choose = (action: RoomDeckComposeAction) => {
    close();
    onSelect(action);
  };

  return (
    <>
      <TouchableOpacity
        accessibilityLabel={open ? 'Close compose menu' : 'Open compose menu'}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityValue={{ text: open ? '×' : '+' }}
        onPress={() => setOpen((value) => !value)}
        style={styles.fab}
        testID="room-deck-compose-fab"
      >
        <Animated.View style={[styles.fabGlyph, glyphStyle]}>
          <Svg
            accessibilityElementsHidden
            focusable={false}
            height={FAB_GLYPH_SIZE}
            viewBox="0 0 24 24"
            width={FAB_GLYPH_SIZE}
          >
            <Path
              fill="none"
              stroke="#1A0F22"
              strokeLinecap="square"
              strokeWidth={FAB_GLYPH_STROKE_WIDTH}
              d="M12 4v16M4 12h16"
            />
          </Svg>
        </Animated.View>
      </TouchableOpacity>

      {open && (
        <HullActionSheetModal
          accessibilityLabel="Close compose menu"
          modalTestID="room-deck-compose-menu"
          onClose={close}
          scrimTestID="room-deck-compose-scrim"
          testID="room-deck-compose-sheet"
          title="New"
          visible
        >
          <View style={styles.optionList} testID="room-deck-compose-options">
            {COMPOSE_OPTIONS.map((option) => (
              <HullActionSheetRow
                accessibilityLabel={`${option.label}. ${option.description}`}
                label={option.label}
                key={option.action}
                leading={
                  <View style={styles.glyphColumn}>
                    <ComposeGlyph action={option.action} />
                  </View>
                }
                metadata={option.description}
                metadataWrap
                onPress={() => choose(option.action)}
                testID={`room-deck-compose-${option.action}`}
              />
            ))}
          </View>
          <HullActionSheetCancel onPress={close} testID="room-deck-compose-close" />
        </HullActionSheetModal>
      )}
    </>
  );
}

function ComposeGlyph({ action }: { action: RoomDeckComposeAction }) {
  if (action === 'room') {
    return <RoomGlyph size={GLYPH_SIZE} testID="room-deck-compose-glyph-room" />;
  }

  const common = {
    fill: 'none',
    stroke: brand.mark,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    strokeWidth: GLYPH_STROKE_WIDTH,
  };

  return (
    <Svg
      accessibilityElementsHidden
      focusable={false}
      height={GLYPH_SIZE}
      testID={`room-deck-compose-glyph-${action}`}
      viewBox="0 0 24 24"
      width={GLYPH_SIZE}
    >
      {action === 'message' && (
        <>
          <Rect {...common} x="3.5" y="5.5" width="17" height="13" rx="0.75" />
          <Path {...common} d="M4 7l8 6 8-6" />
        </>
      )}
      {action === 'invite' && (
        <Path
          {...common}
          d="M5 19c-1-3.6.1-6.4 3.2-7.8 3.2-1.4 6.3.2 6.3 3 0 2.7-3 4.4-5.9 3-2.8-1.4-3-5.2-.9-7.8 2.3-2.9 7-2.5 9.8-5.3.8-.8 1.3-1.6 1.5-2.1"
        />
      )}
      {action === 'agent' && <Polygon {...common} points="12 4.5 20 19.5 4 19.5" />}
      {action === 'join' && (
        <>
          <Path {...common} d="M5 20V4h13v16" />
          <Path {...common} d="M8 20V6.5L16 5v15Z" />
          <Circle {...common} cx="13.8" cy="12.7" r="0.45" />
        </>
      )}
    </Svg>
  );
}

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return {
    optionList: {},
    glyphColumn: {
      width: 30,
      flexShrink: 0,
      alignItems: 'center',
      justifyContent: 'center',
    },
    fab: {
      width: 48,
      height: 48,
      flexShrink: 0,
      borderRadius: groknight.radius,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: brand.mark,
      shadowColor: '#000000',
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.5,
      shadowRadius: 12,
      elevation: 10,
    },
    fabGlyph: {
      width: FAB_GLYPH_SIZE,
      height: FAB_GLYPH_SIZE,
      alignItems: 'center',
      justifyContent: 'center',
    },
  };
});
