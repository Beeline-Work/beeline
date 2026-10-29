import React from 'react';
import { Pressable, Text, View, type PressableProps, type ViewProps } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { CHEVRON_ROW_SIZE, ChevronGlyph } from './ChevronGlyph';

/** Shared steps, repository-event and system-line disclosure row. */
export function LedgerDisclosure({
  expanded,
  onPress,
  children,
  rowTestID,
  accessibilityLabel,
  accessibilityState,
  textToggle = false,
}: {
  /** Rich system text that ends in its own more/less word, so no chevron. */
  textToggle?: boolean;
  expanded: boolean;
  onPress: NonNullable<PressableProps['onPress']>;
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
      style={textToggle ? styles.textToggleRow : styles.row}
      testID={rowTestID}
    >
      {textToggle ? (
        children
      ) : (
        <>
          <View style={styles.chevron}>
            <ChevronGlyph
              color={theme.buzz.textMuted}
              direction={expanded ? 'down' : 'right'}
              size={CHEVRON_ROW_SIZE}
            />
          </View>
          <Text style={styles.label}>{children}</Text>
        </>
      )}
    </Pressable>
  );
}
/** Shared container without additional transcript spacing. */
export function LedgerLogGroup({ style, ...props }: ViewProps) {
  return <View {...props} style={style} />;
}

const styles = StyleSheet.create(({ buzz }) => ({
  row: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: buzz.space.sm,
  },
  textToggleRow: { minHeight: 44, minWidth: 44 },
  chevron: { width: CHEVRON_ROW_SIZE, flexShrink: 0, justifyContent: 'center' },
  label: { ...buzz.type.meta, flex: 1, minWidth: 0, color: buzz.textSecondary },
}));
