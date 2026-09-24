import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';

export interface PageHeaderProps {
  /** The section's one title. */
  title: string;
  /** Optional second line under the title. */
  meta?: string;
  /** Workspace context above the section title. */
  eyebrow?: string;
  /** Count aligned with the title block's trailing edge. */
  trailing?: string;
  /** Renders the back control when provided. */
  onBack?: () => void;
  backAccessibilityLabel?: string;
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
  trailing,
  onBack,
  backAccessibilityLabel = 'Back',
  testID,
}: PageHeaderProps) {
  return (
    <View style={[styles.header, eyebrow && styles.headerWithEyebrow]} testID={testID}>
      {onBack ? (
        <Pressable
          accessibilityLabel={backAccessibilityLabel}
          accessibilityRole="button"
          onPress={onBack}
          style={styles.back}
        >
          <Ionicons color={styles.headerTitle.color} name="chevron-back" size={22} />
        </Pressable>
      ) : null}
      <View style={styles.headerCopy}>
        {eyebrow ? (
          <Text numberOfLines={1} style={styles.headerEyebrow}>
            {eyebrow}
          </Text>
        ) : null}
        <Text style={[styles.headerTitle, eyebrow && styles.headerHero]}>{title}</Text>
        {meta ? <Text style={styles.headerMeta}>{meta}</Text> : null}
      </View>
      {trailing ? <Text style={styles.headerTrailing}>{trailing}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  header: {
    minHeight: 60,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.buzz.border,
    paddingHorizontal: 12,
  },
  headerWithEyebrow: { minHeight: 66 },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerCopy: { flex: 1, minWidth: 0 },
  headerEyebrow: { ...theme.buzz.type.meta, color: theme.buzz.textMuted },
  headerTitle: { ...theme.buzz.type.bodyStrong, color: theme.buzz.textPrimary },
  headerHero: { ...theme.buzz.type.hero },
  headerMeta: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet, marginTop: 2 },
  headerTrailing: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet, marginLeft: 12 },
}));
