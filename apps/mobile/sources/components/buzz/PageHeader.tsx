import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { CHEVRON_BACK_SIZE, ChevronGlyph } from './ChevronGlyph';

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
  /** Renders the back control when provided. */
  onBack?: () => void;
  backAccessibilityLabel?: string;
  backTestID?: string;
  titleTestID?: string;
  testID?: string;
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
  onBack,
  backAccessibilityLabel = 'Back',
  backTestID,
  titleTestID,
  testID,
}: PageHeaderProps) {
  return (
    <View style={[styles.header, eyebrow && styles.headerWithEyebrow]} testID={testID}>
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
      <View style={styles.headerCopy}>
        {eyebrow ? (
          <Text numberOfLines={1} style={styles.headerEyebrow}>
            {eyebrow}
          </Text>
        ) : null}
        <Text style={[styles.headerTitle, prominent && styles.headerHero]} testID={titleTestID}>
          {title}
        </Text>
        {meta ? <Text style={styles.headerMeta}>{meta}</Text> : null}
      </View>
      {trailing ? <Text style={styles.headerTrailing}>{trailing}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    minHeight: 66,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.buzz.border,
    paddingHorizontal: 12,
  },
  headerWithEyebrow: {},
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerCopy: { flex: 1, minWidth: 0 },
  headerEyebrow: { ...theme.buzz.type.meta, color: theme.buzz.textMuted },
  headerTitle: { ...theme.buzz.type.bodyStrong, color: theme.buzz.textPrimary },
  headerHero: { ...theme.buzz.type.hero },
  headerMeta: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet, marginTop: 2 },
  headerTrailing: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet, marginLeft: 12 },
}));
