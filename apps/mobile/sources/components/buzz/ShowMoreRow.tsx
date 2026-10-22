import React from 'react';
import { Pressable, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { HULL_SHEET_INSET } from '@/buzz/hull-sheet-layout';
import { CHEVRON_ROW_SIZE, ChevronGlyph } from './ChevronGlyph';

/**
 * The one "show more" control under a capped list: a quiet line with a
 * chevron, 44 px tall. Replaces hand-built Load more / Show N more links.
 */
export function ShowMoreRow({
  accessibilityLabel,
  disabled = false,
  expanded,
  inset = 'row',
  label,
  onPress,
  testID,
}: {
  accessibilityLabel?: string;
  disabled?: boolean;
  /** When set, this row discloses optional detail in a transcript card. */
  expanded?: boolean;
  /** `row` aligns with page rows; `sheet` with sheet rows; `none` is flush. */
  inset?: 'row' | 'sheet' | 'none';
  /** Sentence case, with the count when it is known: `Show 6 more`. */
  label: string;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      accessibilityState={{ disabled, ...(expanded !== undefined ? { expanded } : {}) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        inset === 'row' && styles.rowInset,
        inset === 'sheet' && styles.sheetInset,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
      testID={testID}
    >
      <Text numberOfLines={1} style={[styles.label, expanded !== undefined && styles.disclosureLabel]}>
        {label}
      </Text>
      <ChevronGlyph color={expanded !== undefined ? styles.disclosureLabel.color : styles.chevron.color} direction={expanded === undefined ? 'right' : expanded ? 'up' : 'down'} size={CHEVRON_ROW_SIZE} />
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    row: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      gap: hull.space.xs,
    },
    rowInset: { paddingHorizontal: hull.space.sm },
    sheetInset: { paddingHorizontal: HULL_SHEET_INSET },
    pressed: { backgroundColor: hull.bgPressed },
    disabled: { opacity: 0.42 },
    label: { ...Typography.default(), ...hull.type.body, color: hull.textSecondary },
    disclosureLabel: { ...Typography.default(), ...hull.type.meta, color: hull.accent },
    chevron: { color: hull.textMuted },
  };
});
