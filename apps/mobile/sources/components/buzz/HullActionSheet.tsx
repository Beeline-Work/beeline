import React from 'react';
import { Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { HullFloatingSurface, HullModal } from './HullDialog';

type HullActionSheetProps = {
  children: React.ReactNode;
  grip?: boolean;
  style?: StyleProp<ViewStyle>;
  subtitle?: string;
  testID?: string;
  title?: string;
};

/**
 * Bottom-sheet member of the Hull family. The surface is the same textured
 * HullSurface used by centered dialogs; a grip and hairlines carry structure.
 */
export function HullActionSheet({
  children,
  grip = true,
  style,
  subtitle,
  testID,
  title,
}: HullActionSheetProps) {
  return (
    <HullFloatingSurface style={[styles.sheet, style]} testID={testID}>
      {grip ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={styles.gripSlot}
        >
          <View style={styles.grip} />
        </View>
      ) : null}
      {title ? <Text style={styles.title}>{title}</Text> : null}
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      {children}
    </HullFloatingSurface>
  );
}

export type HullActionSheetAction = {
  accessibilityLabel?: string;
  destructive?: boolean;
  disabled?: boolean;
  label: string;
  leading?: React.ReactNode;
  metadata?: string;
  onPress: () => void;
  selected?: boolean;
  testID?: string;
};

export function HullActionSheetRow({
  accessibilityLabel,
  destructive = false,
  disabled = false,
  label,
  leading,
  metadata,
  onPress,
  selected = false,
  testID,
}: HullActionSheetAction) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? `${label}${metadata ? `. ${metadata}` : ''}`}
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        pressed && styles.rowPressed,
        disabled && styles.disabled,
      ]}
      testID={testID}
    >
      {leading}
      <Text numberOfLines={1} style={[styles.rowLabel, destructive && styles.destructive]}>
        {label}
      </Text>
      {metadata || selected ? (
        <Text numberOfLines={1} style={styles.metadata}>
          {selected ? 'SELECTED' : metadata}
        </Text>
      ) : null}
    </Pressable>
  );
}

export function HullActionSheetCancel({
  label = 'Cancel',
  onPress,
  testID,
}: {
  label?: string;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.cancel, pressed && styles.rowPressed]}
      testID={testID}
    >
      <Text style={styles.cancelText}>{label}</Text>
    </Pressable>
  );
}

type HullActionSheetModalProps = {
  children: React.ReactNode;
  accessibilityLabel?: string;
  modalTestID?: string;
  onClose: () => void;
  scrimTestID?: string;
  testID?: string;
  title?: string;
  subtitle?: string;
  visible: boolean;
};

export function HullActionSheetModal({
  accessibilityLabel,
  children,
  modalTestID,
  onClose,
  scrimTestID,
  subtitle,
  testID,
  title,
  visible,
}: HullActionSheetModalProps) {
  const insets = useSafeAreaInsets();
  return (
    <HullModal
      accessibilityLabel={accessibilityLabel ?? 'Close action sheet'}
      contentStyle={styles.modalContent}
      onRequestClose={onClose}
      placement="bottom"
      scrimTestID={scrimTestID}
      testID={modalTestID}
      visible={visible}
    >
      <HullActionSheet
        style={{ paddingBottom: Math.max(insets.bottom, 10) }}
        subtitle={subtitle}
        testID={testID}
        title={title}
      >
        {children}
      </HullActionSheet>
    </HullModal>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    modalContent: { paddingHorizontal: 0 },
    sheet: {
      width: '100%',
    },
    gripSlot: { height: 18, alignItems: 'center', justifyContent: 'center' },
    grip: {
      width: 34,
      height: 3,
      borderRadius: hull.radius,
      backgroundColor: hull.textDisabled,
      opacity: 0.55,
    },
    title: {
      ...Typography.default('semiBold'),
      paddingHorizontal: 22,
      paddingTop: 4,
      paddingBottom: 10,
      color: hull.chrome,
      fontFamily: hull.proseSemibold,
      fontSize: 16,
      lineHeight: 22,
    },
    subtitle: {
      ...Typography.default(),
      paddingHorizontal: 22,
      paddingBottom: 10,
      color: hull.textSecondary,
      fontFamily: hull.proseRegular,
      fontSize: 13,
      lineHeight: 18,
    },
    row: {
      minHeight: 52,
      paddingHorizontal: 22,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: hull.border,
    },
    rowPressed: { backgroundColor: hull.bgPressed },
    disabled: { opacity: 0.42 },
    rowLabel: {
      ...Typography.default(),
      fontFamily: hull.proseRegular,
      flex: 1,
      minWidth: 0,
      color: hull.textPrimary,
      fontSize: 15,
      lineHeight: 20,
    },
    metadata: {
      ...Typography.mono(),
      flexShrink: 0,
      maxWidth: '46%',
      color: hull.textDisabled,
      fontSize: 11,
      lineHeight: 15,
    },
    destructive: { color: hull.dialogDanger },
    cancel: {
      minHeight: 54,
      paddingHorizontal: 22,
      alignItems: 'center',
      justifyContent: 'center',
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: hull.border,
    },
    cancelText: {
      ...Typography.mono('semiBold'),
      color: hull.chrome,
      fontSize: 12,
      lineHeight: 16,
      letterSpacing: 0.8,
      textTransform: 'uppercase',
    },
  };
});
