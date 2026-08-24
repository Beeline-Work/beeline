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
import brand from '@/buzz/brand.json';
import { HullActionSheet } from '@/components/buzz/HullActionSheet';
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

const COMPOSE_GROUPS: readonly { label: string; options: readonly ComposeOption[] }[] = [
  {
    label: 'START',
    options: [
      { action: 'message', label: 'Message', description: 'Direct message a person' },
      { action: 'room', label: 'Room', description: 'New room in this workspace' },
    ],
  },
  {
    label: 'WORKSPACE',
    options: [
      { action: 'invite', label: 'Invite', description: 'Bring a person into the workspace' },
      { action: 'agent', label: 'Agent', description: 'Seat an agent here' },
      { action: 'join', label: 'Join', description: 'Paste a Workspace invite' },
    ],
  },
] as const;

const ACTION_GLYPHS: Record<RoomDeckComposeAction, string> = {
  message: '○',
  room: '⌑',
  invite: '○',
  agent: '△',
  join: '▢',
};

const GLYPH_ROTATION_MS = 180;

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
              {COMPOSE_GROUPS.map((group, groupIndex) => (
                <View
                  key={group.label}
                  style={[styles.group, groupIndex > 0 && styles.groupSpacing]}
                  testID={`room-deck-compose-group-${group.label.toLowerCase()}`}
                >
                  <Text style={styles.groupLabel}>{group.label}</Text>
                  {group.options.map((option) => (
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
              ))}
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
  return <Text style={styles.glyph}>{ACTION_GLYPHS[action]}</Text>;
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
    group: { paddingHorizontal: 8 },
    groupSpacing: { marginTop: 12 },
    groupLabel: {
      ...Typography.mono('semiBold'),
      height: 22,
      paddingHorizontal: 44,
      color: groknight.textMuted,
      fontSize: 9,
      lineHeight: 22,
      letterSpacing: 0.8,
    },
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
    glyph: {
      ...Typography.mono('semiBold'),
      color: brand.mark,
      fontSize: 20,
      lineHeight: 24,
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
