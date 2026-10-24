import * as React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { typeRoles } from '@/buzz/groknight';
import { HULL_SHEET_INSET } from '@/buzz/hull-sheet-layout';
import Svg, { Path } from 'react-native-svg';
import { DECORATIVE_GLYPH_PROPS } from './decorative-glyph';

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
  surface = 'inherit',
  count,
  actionAccessibilityLabel,
  actionTestID,
  onAction,
  actionDisabled,
  wordAction,
  tapLineHeight = false,
  testID,
}: {
  title: string;
  /**
   * Content already supplies its own screen inset; `row` aligns with
   * SettingsRow titles; `sheet` aligns with sheet rows; `roomList` puts the
   * label and the + ink on the Room list edge.
   */
  inset?: 'screen' | 'content' | 'row' | 'sheet' | 'roomList';
  /** Flush when the surrounding section already supplies its vertical gap. */
  spacing?: 'section' | 'flush';
  /**
   * Ordinary labels inherit their container. Sticky headers must opt into an
   * opaque screen fill (or supply one on their surrounding sticky row).
   * `sheet` preserves the existing sheet spacing while inheriting its fill.
   */
  surface?: 'inherit' | 'screen' | 'sheet';
  testID?: string;
  actionDisabled?: boolean;
  count?: number;
  actionAccessibilityLabel?: string;
  actionTestID?: string;
  onAction?: () => void;
  /** A word action such as CLEAR, before the + option. */
  wordAction?: SectionHeaderWordAction;
  /** Preserve the desktop sidebar tap line. */
  tapLineHeight?: boolean;
}) {
  return (
    <View
      style={[
        styles.sectionHeader,
        surface === 'screen' && styles.screenSurface,
        inset === 'content' && styles.contentInset,
        inset === 'row' && styles.rowInset,
        inset === 'sheet' && styles.sheetInset,
        inset === 'roomList' && (tapLineHeight ? styles.roomListCompactInset : styles.roomListInset),
        surface === 'sheet' && styles.sheetSurface,
        !tapLineHeight && styles.phoneSpacing,
        onAction && !tapLineHeight && styles.actionSpacing,
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
        <View style={tapLineHeight && styles.tapLine}>
          <Pressable
            accessibilityLabel={actionAccessibilityLabel}
            accessibilityRole="button"
            onPress={onAction}
            disabled={actionDisabled}
            accessibilityState={{ disabled: actionDisabled }}
            hitSlop={tapLineHeight ? ACTION_HIT_SLOP : undefined}
            style={({ pressed }) => [styles.sectionHeaderAction, tapLineHeight && styles.compactAction, pressed && styles.pressed]}
            testID={actionTestID}
          >
            <SectionAddGlyph color={styles.sectionHeaderActionGlyph.color} />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

/** A heavy, round-capped plus: the old thin stroke was hard to see. */
function SectionAddGlyph({ color }: { color: string }) {
  return (
    <Svg
      {...DECORATIVE_GLYPH_PROPS}
      width={ACTION_GLYPH}
      height={ACTION_GLYPH}
      viewBox="0 0 24 24"
      stroke={color}
      strokeWidth={ACTION_STROKE}
      strokeLinecap="round"
      fill="none"
    >
      <Path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

/** Phones use a full target; desktop keeps its compact mark and tap-line wrapper. */
const ACTION_GLYPH = 24;
const ACTION_STROKE = 2.4;
const LABEL_LINE = typeRoles.sectionLabel.lineHeight;
const ACTION_HIT_SLOP = {
  top: (44 - ACTION_GLYPH) / 2,
  bottom: (44 - ACTION_GLYPH) / 2,
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
    },
    phoneSpacing: { paddingTop: hull.space.md },
    screenSurface: { backgroundColor: hull.bgTerminal },
    actionSpacing: { paddingTop: 0, paddingBottom: 0, minHeight: 44 },
    contentInset: { paddingHorizontal: 0 },
    rowInset: { paddingHorizontal: hull.space.sm },
    sheetInset: { paddingHorizontal: HULL_SHEET_INSET },
    roomListInset: {
      paddingLeft: hull.roomList.edge,
      paddingRight: hull.roomList.addEnd,
    },
    roomListCompactInset: {
      paddingLeft: hull.roomList.edge,
      paddingRight: hull.roomList.compactAddEnd,
    },
    sheetSurface: { paddingTop: hull.space.md, backgroundColor: 'transparent' },
    flushSpacing: { paddingTop: 0 },
    sectionHeaderText: {
      ...Typography.default('semiBold'),
      ...hull.type.sectionLabel,
      lineHeight: hull.type.sectionCount.lineHeight,
      color: hull.textMuted,
      flex: 1,
    },
    tapLine: { minHeight: 44, justifyContent: 'center' },
    sectionHeaderAction: {
      width: 44,
      height: 44,
      marginLeft: hull.space.sm,
      alignItems: 'center',
      justifyContent: 'center',
    },
    compactAction: { width: ACTION_GLYPH, height: ACTION_GLYPH },
    sectionHeaderActionGlyph: { color: hull.accent },
    pressed: { opacity: 0.7 },
    disabled: { opacity: 0.42 },
    wordAction: { marginLeft: hull.space.sm },
    wordActionText: {
      ...Typography.default('semiBold'),
      ...hull.type.sectionLabel,
      color: hull.accent,
    },
    // Held to the label's line so the count never makes the header taller.
    sectionCount: {
      ...hull.type.sectionCount,
      color: hull.ledgerQuiet,
    },
  };
});
