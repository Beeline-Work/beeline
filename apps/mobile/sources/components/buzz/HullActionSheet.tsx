import React from 'react';
import { Pressable, Switch, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
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
      {title ? (
        <Text accessibilityRole="header" style={styles.title}>
          {title}
        </Text>
      ) : null}
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      {children}
    </HullFloatingSurface>
  );
}

/**
 * The sheet row's trailing column is a closed vocabulary, and every form ends
 * on the SAME axis — the sheet's own trailing inset:
 *
 *   - `metadata`  the row's current value (a setting's state, a source name);
 *   - `toggle`    a switch, for a row that flips something on the spot;
 *   - `chevron`   for a row that opens something — `'right'` to leave for it,
 *                 `'down'` while it stands open beneath this row;
 *   - nothing     for a plain action, which acts the moment it is pressed.
 *
 * A row never invents a fifth mark, and it never wears a box: the sheet is a
 * list, so rows are parted by one hairline and nothing else (DESIGN.md → Shape).
 */
export type HullActionSheetAction = {
  accessibilityLabel?: string;
  /** The trailing chevron of a row that opens something. */
  chevron?: 'right' | 'down';
  /** The quiet line beneath the label. A full sentence never shares the
   *  label's line, so it wraps here rather than ellipsizing beside it. */
  description?: string;
  destructive?: boolean;
  disabled?: boolean;
  label: string;
  leading?: React.ReactNode;
  /** The row's current value, on the trailing axis. Never in the label. */
  metadata?: string;
  /** A row with no `onPress` and no `toggle` is a fact, not a control. */
  onPress?: () => void;
  selected?: boolean;
  testID?: string;
  /** The trailing switch of a row that toggles. Excludes `chevron`. */
  toggle?: {
    accessibilityLabel?: string;
    disabled?: boolean;
    onValueChange: (next: boolean) => void;
    value: boolean;
  };
};

export function HullActionSheetRow({
  accessibilityLabel,
  chevron,
  description,
  destructive = false,
  disabled = false,
  label,
  leading,
  metadata,
  onPress,
  selected = false,
  testID,
  toggle,
}: HullActionSheetAction) {
  const { theme } = useUnistyles();
  const metadataText = selected ? 'SELECTED' : metadata;
  const spoken = [metadataText, description].filter(Boolean).join('. ');
  const body = (
    <>
      {leading}
      <View style={styles.copy}>
        <Text numberOfLines={1} style={[styles.rowLabel, destructive && styles.destructive]}>
          {label}
        </Text>
        {description ? <Text style={styles.description}>{description}</Text> : null}
      </View>
      {metadataText ? (
        <Text numberOfLines={1} style={styles.metadata}>
          {metadataText}
        </Text>
      ) : null}
      {toggle ? (
        // A pressable row IS the switch to a screen reader (role + checked
        // below), so the control itself must not be announced a second time.
        <View
          accessibilityElementsHidden={Boolean(onPress)}
          importantForAccessibility={onPress ? 'no-hide-descendants' : 'auto'}
        >
          <Switch
            accessibilityLabel={toggle.accessibilityLabel ?? label}
            disabled={toggle.disabled ?? disabled}
            onValueChange={toggle.onValueChange}
            thumbColor={theme.buzz.textPrimary}
            trackColor={{ false: theme.buzz.bgRaised, true: theme.buzz.accent }}
            value={toggle.value}
          />
        </View>
      ) : chevron ? (
        <Text accessibilityElementsHidden style={styles.chevron}>
          {chevron === 'down' ? '\u2304' : '\u203a'}
        </Text>
      ) : null}
    </>
  );
  const rowAccessibilityLabel = accessibilityLabel ?? (spoken ? `${label}. ${spoken}` : label);
  if (!onPress) {
    return (
      <View accessibilityLabel={rowAccessibilityLabel} style={styles.row} testID={testID}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityLabel={rowAccessibilityLabel}
      accessibilityRole={toggle ? 'switch' : 'button'}
      accessibilityState={toggle ? { checked: toggle.value, disabled } : { disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        pressed && styles.rowPressed,
        disabled && styles.disabled,
      ]}
      testID={testID}
    >
      {body}
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
  /** Held false while a row's inline editor has unsaved work in flight. */
  dismissOnBackdrop?: boolean;
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
  dismissOnBackdrop,
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
      dismissOnBackdrop={dismissOnBackdrop}
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

/** The sheet's own horizontal inset. Rows own it, so anything a caller hangs
 *  between rows (an inline editor, a picker) lines up by spreading it too. */
export const HULL_SHEET_INSET = 22;

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
      ...hull.type.bodyStrong,
      paddingHorizontal: HULL_SHEET_INSET,
      paddingTop: hull.space.xs,
      paddingBottom: hull.space.sm,
      color: hull.chrome,
      fontFamily: hull.proseSemibold,
    },
    subtitle: {
      ...Typography.default(),
      ...hull.type.meta,
      paddingHorizontal: HULL_SHEET_INSET,
      paddingBottom: hull.space.sm,
      color: hull.textSecondary,
      fontFamily: hull.proseRegular,
    },
    row: {
      minHeight: 52,
      paddingHorizontal: HULL_SHEET_INSET,
      paddingVertical: hull.space.sm,
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: hull.border,
    },
    rowPressed: { backgroundColor: hull.bgPressed },
    disabled: { opacity: 0.42 },
    copy: { flex: 1, minWidth: 0 },
    rowLabel: {
      ...Typography.default(),
      ...hull.type.body,
      fontFamily: hull.proseRegular,
      color: hull.textPrimary,
    },
    // The quiet line beneath the label: a full sentence, wrapping as far as it
    // needs, never an ellipsis and never crammed into the label above it.
    description: {
      ...Typography.default(),
      ...hull.type.meta,
      marginTop: hull.space.xs,
      color: hull.textMuted,
      fontFamily: hull.proseRegular,
    },
    // The value, on the trailing axis. `flexShrink: 0` keeps it whole and the
    // cap keeps a long one from eating the label.
    metadata: {
      ...Typography.default(),
      ...hull.type.meta,
      flexShrink: 0,
      maxWidth: '46%',
      textAlign: 'right',
      color: hull.textMuted,
      fontFamily: hull.proseRegular,
    },
    // Right-aligned in its own column so the glyph's trailing edge lands on the
    // row's padding edge — the one axis every trailing mark shares (C99, C102).
    chevron: {
      ...Typography.default(),
      ...hull.type.hero,
      width: 16,
      textAlign: 'right',
      color: hull.textMuted,
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
      ...Typography.default(),
      ...hull.type.body,
      color: hull.chrome,
      fontFamily: hull.proseRegular,
    },
  };
});
