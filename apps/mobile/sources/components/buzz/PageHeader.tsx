import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { StyleSheet } from 'react-native-unistyles';

export interface PageHeaderProps {
  /** The section's one title. */
  title: string;
  /** Optional second line under the title. */
  meta?: string;
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
  onBack,
  backAccessibilityLabel = 'Back',
  testID,
}: PageHeaderProps) {
  return (
    <View style={styles.header} testID={testID}>
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
        <Text style={styles.headerTitle}>{title}</Text>
        {meta ? <Text style={styles.headerMeta}>{meta}</Text> : null}
      </View>
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
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerCopy: { flex: 1, minWidth: 0 },
  headerTitle: { ...theme.buzz.type.bodyStrong, color: theme.buzz.textPrimary },
  headerMeta: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet, marginTop: 2 },
}));
