import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { CHEVRON_BACK_SIZE, ChevronGlyph } from './ChevronGlyph';
import { Typography } from '@/constants/Typography';
import { appBoardColors, appBoardType } from '@/buzz/app-board-style';

export interface PageHeaderProps {
  /** The section's one title. */
  title: string;
  /** Optional second line under the title. */
  meta?: string;
  /** Workspace context above the section title. */
  eyebrow?: string;
  /** Uses the large page-title treatment shared by profile-shaped surfaces. */
  prominent?: boolean;
  /** Count aligned with the title block's trailing edge. */
  trailing?: string;
  /** What a screen reader says for `trailing`, when the bare text is not enough. */
  trailingAccessibilityLabel?: string;
  /** One control after the trailing text, such as a page's add button. */
  action?: React.ReactNode;
  /** Renders the back control when provided. */
  onBack?: () => void;
  backAccessibilityLabel?: string;
  backTestID?: string;
  titleTestID?: string;
  testID?: string;
  /** Approved Connect an app board treatment within the shared header. */
  appBoard?: boolean;
}

/**
 * The one page header for a full-bleed section on desktop: title, optional
 * meta line, optional back control, left-aligned at the content pane's own
 * inset. The navigation stack header centers a legacy max-width column on
 * desktop, so a section that draws its own header uses this instead.
 */
export function PageHeader({
  title,
  meta,
  eyebrow,
  prominent = false,
  trailing,
  trailingAccessibilityLabel,
  action,
  onBack,
  backAccessibilityLabel = 'Back',
  backTestID,
  titleTestID,
  testID,
  appBoard = false,
}: PageHeaderProps) {
  return (
    <View style={[styles.header, eyebrow && styles.headerWithEyebrow, appBoard && styles.appBoardHeader]} testID={testID}>
      {onBack ? (
        <TouchableOpacity
          accessibilityLabel={backAccessibilityLabel}
          accessibilityRole="button"
          onPress={onBack}
          style={styles.back}
          testID={backTestID}
        >
          <ChevronGlyph
            color={styles.headerTitle.color}
            direction="left"
            size={CHEVRON_BACK_SIZE}
          />
        </TouchableOpacity>
      ) : null}
      <View style={[styles.headerCopy, appBoard && styles.appBoardCopy]}>
        {eyebrow ? (
          <Text numberOfLines={1} style={[styles.headerEyebrow, appBoard && Typography.ledger(), appBoard && styles.appBoardEyebrow]}>
            {eyebrow}
          </Text>
        ) : null}
        <Text
          accessibilityRole="header"
          style={[styles.headerTitle, prominent && styles.headerHero, appBoard && Typography.ledger('medium'), appBoard && styles.appBoardTitle]}
          testID={titleTestID}
        >
          {title}
        </Text>
        {meta ? <Text style={styles.headerMeta}>{meta}</Text> : null}
      </View>
      {trailing ? (
        <Text accessibilityLabel={trailingAccessibilityLabel} style={styles.headerTrailing}>
          {trailing}
        </Text>
      ) : null}
      {action}
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const board = appBoardColors(theme.buzz);
  return {
  header: {
    minHeight: 66,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.buzz.border,
    // The Corners page's inset, which every section page now shares.
    paddingHorizontal: theme.buzz.space.sm,
  },
  headerWithEyebrow: {},
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerCopy: { flex: 1, minWidth: 0 },
  headerEyebrow: { ...theme.buzz.type.meta, color: theme.buzz.textMuted },
  headerTitle: { ...theme.buzz.type.bodyStrong, color: theme.buzz.textPrimary },
  headerHero: { ...theme.buzz.type.hero },
  headerMeta: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet, marginTop: 2 },
  // Reserved and right-aligned so a count ends at the same x for 9 and for 10.
  headerTrailing: {
    ...theme.buzz.type.meta,
    color: theme.buzz.textMuted,
    minWidth: theme.buzz.space.lg,
    paddingHorizontal: theme.buzz.space.sm,
    textAlign: 'right',
  },
  appBoardHeader: { gap: 14, paddingLeft: 16, paddingRight: 20, paddingTop: 18, paddingBottom: 16,
    borderBottomWidth: 1, borderBottomColor: board.border },
  appBoardCopy: { gap: 2 },
  appBoardEyebrow: { ...appBoardType.eyebrow, color: board.quiet },
  appBoardTitle: { ...appBoardType.title, color: board.ink },
  };
});
