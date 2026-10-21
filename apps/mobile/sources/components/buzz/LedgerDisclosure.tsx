import React from 'react';
import { Pressable, Text, View } from 'react-native';
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
      onPress={onPress}
      style={styles.row}
      testID={rowTestID}
    >
      <View style={styles.chevron}>
        <ChevronGlyph
          color={theme.buzz.ledgerGhost}
          direction={expanded ? 'up' : 'down'}
          size={CHEVRON_ROW_SIZE}
        />
      </View>
      <Text style={styles.label}>{children}</Text>
    </Pressable>
  );
}
const styles = StyleSheet.create(({ buzz }) => ({
  row: {
    minHeight: 44,
    minWidth: 0,
    justifyContent: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: buzz.borderQuiet,
    paddingHorizontal: buzz.space.xs,
    flexDirection: 'row',
    alignItems: 'center',
    gap: buzz.space.sm,
  },
  chevron: { width: 24, flexShrink: 0, justifyContent: 'center' },
  label: { ...buzz.type.machine, flex: 1, minWidth: 0, color: buzz.ledgerQuiet },
}));
