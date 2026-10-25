import React from 'react';
import { Pressable, Text, View, type PressableProps, type ViewProps } from 'react-native';
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
  firstLine = false,
}: {
  /** Render rich system text beside a chevron aligned to its first line. */
  firstLine?: boolean;
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
      style={firstLine ? styles.firstLineRow : styles.row}
      testID={rowTestID}
    >
      <View style={firstLine ? styles.firstLineChevron : styles.chevron}>
        <ChevronGlyph
          color={theme.buzz.textMuted}
          direction={expanded ? 'down' : 'right'}
          size={CHEVRON_ROW_SIZE}
        />
      </View>
      {firstLine ? (
        <View style={styles.content}>{children}</View>
      ) : (
        <Text style={styles.label}>{children}</Text>
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
  firstLineRow: {
    minHeight: 44,
    minWidth: 44,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: buzz.space.sm,
  },
  firstLineChevron: {
    width: CHEVRON_ROW_SIZE,
    height: buzz.type.meta.lineHeight,
    flexShrink: 0,
    justifyContent: 'center',
  },
  content: { flex: 1, minWidth: 0 },
  chevron: { width: CHEVRON_ROW_SIZE, flexShrink: 0, justifyContent: 'center' },
  label: { ...buzz.type.meta, flex: 1, minWidth: 0, color: buzz.textSecondary },
}));
