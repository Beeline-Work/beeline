import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { typeRoles } from '@/buzz/groknight';
import { HULL_SHEET_INSET } from '@/buzz/hull-sheet-layout';
import { Ionicons } from '@expo/vector-icons';

/** A word beside the label that acts on the whole section (CLEAR). */
export type SectionHeaderWordAction = {
  accessibilityLabel?: string;
  disabled?: boolean;
  label: string;
  onPress: () => void;
  testID?: string;
};

export function RoomListSectionHeader({
  title,
  inset = 'screen',
  spacing = 'section',
  surface = 'screen',
  count,
  actionAccessibilityLabel,
  actionTestID,
  onAction,
  actionDisabled,
  wordAction,
  testID,
}: {
  title: string;
  /**
   * Content already supplies its own screen inset; `row` aligns with
   * SettingsRow titles; `sheet` aligns with sheet rows.
   */
  inset?: 'screen' | 'content' | 'row' | 'sheet';
  /** Flush when the surrounding section already supplies its vertical gap. */
  spacing?: 'section' | 'flush';
  /**
   * `sheet` drops the screen fill so the header takes the sheet's own surface
   * instead of a pale band. Not for sticky headers: rows would show through.
   */
  surface?: 'screen' | 'sheet';
  testID?: string;
  actionDisabled?: boolean;
  count?: number;
  actionAccessibilityLabel?: string;
  actionTestID?: string;
  onAction?: () => void;
  /** A word action such as CLEAR, before the + option. */
  wordAction?: SectionHeaderWordAction;
}) {
  return (
    <View
      style={[
        styles.sectionHeader,
        inset === 'content' && styles.contentInset,
        inset === 'row' && styles.rowInset,
        inset === 'sheet' && styles.sheetInset,
        surface === 'sheet' && styles.sheetSurface,
        spacing === 'flush' && styles.flushSpacing,
      ]}
    >
      <Text testID={testID} accessibilityRole="header" style={styles.sectionHeaderText}>
        {title.toUpperCase()}
      </Text>
      {count !== undefined && <Text style={styles.sectionCount}>{count}</Text>}
      {wordAction ? (
        <Pressable
          accessibilityLabel={wordAction.accessibilityLabel ?? wordAction.label}
          accessibilityRole="button"
          accessibilityState={{ disabled: wordAction.disabled }}
          disabled={wordAction.disabled}
          hitSlop={WORD_HIT_SLOP}
          onPress={wordAction.onPress}
          style={({ pressed }) => [
            styles.wordAction,
            pressed && styles.pressed,
            wordAction.disabled && styles.disabled,
          ]}
          testID={wordAction.testID}
        >
          <Text style={styles.wordActionText}>{wordAction.label.toUpperCase()}</Text>
        </Pressable>
      ) : null}
      {onAction ? (
        <Pressable
          accessibilityLabel={actionAccessibilityLabel}
          accessibilityRole="button"
          onPress={onAction}
          disabled={actionDisabled}
          accessibilityState={{ disabled: actionDisabled }}
          hitSlop={ACTION_HIT_SLOP}
          style={({ pressed }) => [styles.sectionHeaderAction, pressed && styles.pressed]}
          testID={actionTestID}
        >
          <Ionicons name="add" size={ACTION_GLYPH} color={styles.sectionHeaderActionGlyph.color} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** The +'s box is one label line tall, so it never makes the header taller;
 *  the slop carries the rest of its 44 px tap area. */
const ACTION_GLYPH = 16;
const LABEL_LINE = typeRoles.sectionHead.lineHeight;
const ACTION_HIT_SLOP = {
  top: (44 - LABEL_LINE) / 2,
  bottom: (44 - LABEL_LINE) / 2,
  left: (44 - ACTION_GLYPH) / 2,
  right: (44 - ACTION_GLYPH) / 2,
};
/** A word sits on the label's line; slop lifts its tap area to 44 px. */
const WORD_HIT_SLOP = { top: (44 - LABEL_LINE) / 2, bottom: (44 - LABEL_LINE) / 2, left: 8, right: 8 };

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    sectionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingTop: hull.space.lg,
      paddingBottom: hull.space.xs,
      paddingHorizontal: hull.space.md,
      backgroundColor: hull.bgTerminal,
    },
    contentInset: { paddingHorizontal: 0 },
    rowInset: { paddingHorizontal: hull.space.sm },
    sheetInset: { paddingHorizontal: HULL_SHEET_INSET },
    sheetSurface: { paddingTop: hull.space.md, backgroundColor: 'transparent' },
    flushSpacing: { paddingTop: 0 },
    sectionHeaderText: {
      ...Typography.default('semiBold'),
      ...hull.type.sectionHead,
      color: hull.textMuted,
      flex: 1,
    },
    sectionHeaderAction: {
      width: ACTION_GLYPH,
      height: LABEL_LINE,
      marginLeft: hull.space.sm,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sectionHeaderActionGlyph: { color: hull.accent },
    pressed: { opacity: 0.7 },
    disabled: { opacity: 0.42 },
    wordAction: { marginLeft: hull.space.sm },
    wordActionText: {
      ...Typography.default('semiBold'),
      ...hull.type.sectionHead,
      color: hull.accent,
    },
    // Held to the label's line so the count never makes the header taller.
    sectionCount: {
      ...hull.type.meta,
      lineHeight: hull.type.sectionHead.lineHeight,
      color: hull.ledgerQuiet,
    },
  };
});
