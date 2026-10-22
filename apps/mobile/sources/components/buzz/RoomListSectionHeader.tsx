import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { typeRoles } from '@/buzz/groknight';

import { Ionicons } from '@expo/vector-icons';
import { Pressable } from 'react-native';

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
  tapLineHeight = false,
  testID,
}: {
  title: string;
  /** Content already supplies its own screen inset; `row` aligns with SettingsRow titles. */
  inset?: 'screen' | 'content' | 'row';
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
  /** Hold the + row to its 44 px tap line, as the desktop sidebar always has. */
  tapLineHeight?: boolean;
}) {
  return (
    <View
      style={[
        styles.sectionHeader,
        inset === 'content' && styles.contentInset,
        inset === 'row' && styles.rowInset,
        surface === 'sheet' && styles.sheetSurface,
        spacing === 'flush' && styles.flushSpacing,
      ]}
    >
      <Text testID={testID} accessibilityRole="header" style={styles.sectionHeaderText}>
        {title.toUpperCase()}
      </Text>
      {count !== undefined && <Text style={styles.sectionCount}>{count}</Text>}
      {onAction ? (
        <View style={tapLineHeight && styles.tapLine}>
          <Pressable
            accessibilityLabel={actionAccessibilityLabel}
            accessibilityRole="button"
            onPress={onAction}
            disabled={actionDisabled}
            accessibilityState={{ disabled: actionDisabled }}
            hitSlop={ACTION_HIT_SLOP}
            style={({ pressed }) => [styles.sectionHeaderAction, pressed && { opacity: 0.7 }]}
            testID={actionTestID}
          >
            <Ionicons
              name="add"
              size={ACTION_GLYPH}
              color={styles.sectionHeaderActionGlyph.color}
            />
          </Pressable>
        </View>
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
    sheetSurface: { paddingTop: hull.space.md, backgroundColor: 'transparent' },
    flushSpacing: { paddingTop: 0 },
    sectionHeaderText: {
      ...Typography.default('semiBold'),
      ...hull.type.sectionHead,
      color: hull.textMuted,
      flex: 1,
    },
    tapLine: { minHeight: 44, justifyContent: 'center' },
    sectionHeaderAction: {
      width: ACTION_GLYPH,
      height: LABEL_LINE,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sectionHeaderActionGlyph: { color: hull.accent },
    // Held to the label's line so the count never makes the header taller.
    sectionCount: { ...hull.type.meta, lineHeight: LABEL_LINE,
      color: hull.ledgerQuiet, marginRight: hull.space.sm },
  };
});
