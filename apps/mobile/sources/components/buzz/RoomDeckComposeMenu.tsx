import React, { useEffect, useState } from 'react';
import { Modal, Pressable, Text, TouchableOpacity, View } from 'react-native';
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import Svg, { Circle, Path, Polygon, Rect } from 'react-native-svg';
import brand from '@/buzz/brand.json';
import { HullActionSheet } from '@/components/buzz/HullActionSheet';
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

/**
 * Flat hull compose affordance for the Room deck. The open copy of the FAB
 * lives inside the native Modal at the exact same coordinates as the closed
 * copy, so the brass plus reads as one control rotating into a close mark.
 */
export function RoomDeckComposeMenu({ onSelect }: RoomDeckComposeMenuProps) {
  const insets = useSafeAreaInsets();
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
        <Animated.View style={glyphStyle}>
          <Text style={styles.fabGlyph}>＋</Text>
        </Animated.View>
      </TouchableOpacity>

      {open && (
        <Modal animationType="fade" onRequestClose={close} transparent visible>
          <View accessibilityViewIsModal style={styles.modalRoot} testID="room-deck-compose-menu">
            <Pressable
              accessibilityLabel="Close compose menu"
              onPress={close}
              style={[StyleSheet.absoluteFill, styles.scrim]}
              testID="room-deck-compose-scrim"
            />

            <HullActionSheet
              style={[styles.sheet, { bottom: 88 + insets.bottom }]}
              testID="room-deck-compose-sheet"
            >
              <View style={styles.optionList} testID="room-deck-compose-options">
                {COMPOSE_OPTIONS.map((option) => (
                  <TouchableOpacity
                    accessibilityLabel={`${option.label}. ${option.description}`}
                    accessibilityRole="button"
                    key={option.action}
                    onPress={() => choose(option.action)}
                    style={styles.option}
                    testID={`room-deck-compose-${option.action}`}
                  >
                    <View style={styles.glyphColumn}>
                      <ComposeGlyph action={option.action} />
                    </View>
                    <View style={styles.optionCopy}>
                      <Text style={styles.optionLabel}>{option.label}</Text>
                      <Text numberOfLines={1} style={styles.optionDescription}>
                        {option.description}
                      </Text>
                    </View>
                  </TouchableOpacity>
                ))}
              </View>
            </HullActionSheet>

            <TouchableOpacity
              accessibilityLabel="Close compose menu"
              accessibilityRole="button"
              accessibilityState={{ expanded: true }}
              accessibilityValue={{ text: '×' }}
              onPress={close}
              style={[styles.fab, styles.openFab, { bottom: 20 + insets.bottom }]}
              testID="room-deck-compose-close"
            >
              <Animated.View style={glyphStyle}>
                <Text style={styles.fabGlyph}>＋</Text>
              </Animated.View>
            </TouchableOpacity>
          </View>
        </Modal>
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
    modalRoot: { flex: 1 },
    scrim: { backgroundColor: 'rgba(10, 5, 14, 0.32)' },
    sheet: {
      position: 'absolute',
      left: 12,
      right: 12,
      maxWidth: 460,
      alignSelf: 'center',
      paddingVertical: 8,
    },
    optionList: { paddingHorizontal: 8 },
    option: {
      minHeight: 68,
      paddingHorizontal: 8,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
    },
    glyphColumn: {
      width: 30,
      flexShrink: 0,
      alignItems: 'center',
      justifyContent: 'center',
    },
    optionCopy: { flex: 1, minWidth: 0 },
    optionLabel: {
      ...Typography.default('semiBold'),
      fontFamily: groknight.proseSemibold,
      color: groknight.textPrimary,
      fontSize: 16,
      lineHeight: 21,
    },
    optionDescription: {
      ...Typography.default(),
      fontFamily: groknight.proseRegular,
      marginTop: 1,
      color: groknight.textMuted,
      fontSize: 11.5,
      lineHeight: 15,
    },
    fab: {
      width: 56,
      height: 56,
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
    openFab: { position: 'absolute', right: 16 },
    fabGlyph: {
      ...Typography.default(),
      color: '#1A0F22',
      fontSize: 30,
      lineHeight: 34,
      fontWeight: '400',
    },
  };
});
