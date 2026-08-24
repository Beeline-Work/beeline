import React, { useEffect, useState } from 'react';
import { Modal, Platform, Pressable, Text, TouchableOpacity, View } from 'react-native';
import { BlurView } from 'expo-blur';
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import { StyleSheet } from 'react-native-unistyles';
import brand from '@/buzz/brand.json';
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

/**
 * Signal-style compose affordance for the Room deck. The open copy of the FAB
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
            <BlurView
              blurMethod={Platform.OS === 'android' ? 'dimezisBlurViewSdk31Plus' : undefined}
              blurReductionFactor={2}
              intensity={12}
              pointerEvents="none"
              style={StyleSheet.absoluteFill}
              tint="dark"
            />
            <Pressable
              accessibilityLabel="Close compose menu"
              onPress={close}
              style={[StyleSheet.absoluteFill, styles.scrim]}
              testID="room-deck-compose-scrim"
            />

            <BlurView
              blurMethod={Platform.OS === 'android' ? 'dimezisBlurViewSdk31Plus' : undefined}
              blurReductionFactor={2}
              intensity={46}
              style={[styles.sheet, { bottom: 88 + insets.bottom }]}
              tint="dark"
              testID="room-deck-compose-sheet"
            >
              {COMPOSE_OPTIONS.map((option, index) => (
                <TouchableOpacity
                  accessibilityLabel={`${option.label}. ${option.description}`}
                  accessibilityRole="button"
                  key={option.action}
                  onPress={() => choose(option.action)}
                  style={[styles.option, index > 0 && styles.optionDivider]}
                  testID={`room-deck-compose-${option.action}`}
                >
                  <View style={styles.iconFrame}>
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
            </BlurView>

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
  const common = {
    fill: 'none',
    stroke: brand.mark,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    strokeWidth: 1.8,
  };
  return (
    <Svg accessibilityElementsHidden height={22} importantForAccessibility="no-hide-descendants" viewBox="0 0 24 24" width={22}>
      {action === 'message' && (
        <>
          <Path {...common} d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
          <Circle cx={9} cy={11} fill={brand.mark} r={1.4} />
          <Circle cx={13} cy={11} fill={brand.mark} r={1.4} />
        </>
      )}
      {action === 'room' && (
        <Path {...common} d="M4 9h16M4 15h16M10 4 8 20M16 4l-2 16" />
      )}
      {action === 'invite' && (
        <>
          <Circle {...common} cx={9} cy={8} r={3.2} />
          <Path {...common} d="M3.5 20a5.5 5.5 0 0 1 11 0M18 8v6M15 11h6" />
        </>
      )}
      {action === 'agent' && (
        <>
          <Path d="M9 4 14.5 14H3.5Z" fill={brand.mark} />
          <Path {...common} d="M17 8v6M14 11h6" />
        </>
      )}
      {action === 'join' && (
        <>
          <Rect {...common} height={12} rx={2.5} width={17} x={3.5} y={6} />
          <Path {...common} d="M8 12h.01M12 12h4" />
        </>
      )}
    </Svg>
  );
}

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return {
    modalRoot: { flex: 1 },
    scrim: { backgroundColor: 'rgba(10, 5, 14, 0.58)' },
    sheet: {
      position: 'absolute',
      left: 12,
      right: 12,
      maxWidth: 460,
      alignSelf: 'center',
      padding: 6,
      overflow: 'hidden',
      borderRadius: 20,
      borderWidth: 1,
      borderColor: '#3A2748',
      backgroundColor: 'rgba(31, 17, 38, 0.76)',
      shadowColor: '#000000',
      shadowOffset: { width: 0, height: 20 },
      shadowOpacity: 0.55,
      shadowRadius: 25,
      elevation: 18,
    },
    option: {
      minHeight: 68,
      paddingHorizontal: 14,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
    },
    optionDivider: { borderTopWidth: 1, borderTopColor: 'rgba(255, 255, 255, 0.05)' },
    iconFrame: {
      width: 40,
      height: 40,
      flexShrink: 0,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: '#2B1B39',
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
      color: '#9C8FAA',
      fontSize: 11.5,
      lineHeight: 15,
    },
    fab: {
      width: 56,
      height: 56,
      flexShrink: 0,
      borderRadius: 16,
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
