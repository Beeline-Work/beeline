import React from 'react';
import { Pressable, Text, View, type ViewProps } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { CHEVRON_ROW_SIZE, ChevronGlyph } from './ChevronGlyph';

/** Shared steps and repository-event disclosure row. */
export function LedgerDisclosure({
  expanded,
  onPress,
  children,
  rowTestID,
  accessibilityLabel,
  accessibilityState,
}: {
  expanded: boolean;
  onPress(): void;
  children: React.ReactNode;
  rowTestID?: string;
  accessibilityLabel: string;
  accessibilityState: { expanded: boolean };
}) {
  const { theme } = useUnistyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={accessibilityState}
      aria-expanded={expanded}
      onPress={onPress}
      style={styles.row}
      testID={rowTestID}
    >
      <View style={styles.chevron}>
        <ChevronGlyph
          color={theme.buzz.textMuted}
          direction={expanded ? 'down' : 'right'}
          size={CHEVRON_ROW_SIZE}
        />
      </View>
      <Text style={styles.label}>{children}</Text>
    </Pressable>
  );
}
/** One spacing rhythm around every expandable transcript group. */
export function LedgerLogGroup({ style, ...props }: ViewProps) {
  return <View {...props} style={[styles.group, style]} />;
}

const styles = StyleSheet.create(({ buzz }) => ({
  group: { marginVertical: buzz.space.sm },
  row: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: buzz.space.sm,
  },
  chevron: { width: CHEVRON_ROW_SIZE, flexShrink: 0, justifyContent: 'center' },
  label: { ...buzz.type.meta, flex: 1, minWidth: 0, color: buzz.textSecondary },
}));
