import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

import { Ionicons } from '@expo/vector-icons';
import { Pressable } from 'react-native';

export function RoomListSectionHeader({
  title,
  inset = 'screen',
  spacing = 'section',
  count,
  actionAccessibilityLabel,
  actionTestID,
  onAction,
  actionDisabled,
  testID,
}: {
  title: string;
  /** Content already supplies its own screen inset. */
  inset?: 'screen' | 'content';
  /** Flush when the surrounding section already supplies its vertical gap. */
  spacing?: 'section' | 'flush';
  testID?: string;
  actionDisabled?: boolean;
  count?: number;
  actionAccessibilityLabel?: string;
  actionTestID?: string;
  onAction?: () => void;
}) {
  return (
    <View
      style={[
        styles.sectionHeader,
        inset === 'content' && styles.contentInset,
        spacing === 'flush' && styles.flushSpacing,
      ]}
    >
      <Text testID={testID} accessibilityRole="header" style={styles.sectionHeaderText}>
        {title.toUpperCase()}
      </Text>
      {count !== undefined && <Text style={styles.sectionCount}>{count}</Text>}
      {onAction ? (
        <Pressable
          accessibilityLabel={actionAccessibilityLabel}
          accessibilityRole="button"
          onPress={onAction}
          disabled={actionDisabled}
          accessibilityState={{ disabled: actionDisabled }}
          hitSlop={8}
          style={({ pressed }) => [styles.sectionHeaderAction, pressed && { opacity: 0.7 }]}
          testID={actionTestID}
        >
          <Ionicons name="add" size={16} color={styles.sectionHeaderActionGlyph.color} />
        </Pressable>
      ) : null}
    </View>
  );
}

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
    flushSpacing: { paddingTop: 0 },
    sectionHeaderText: {
      ...Typography.default('semiBold'),
      ...hull.type.sectionHead,
      color: hull.textMuted,
      flex: 1,
    },
    sectionHeaderAction: {
      minHeight: 44,
      minWidth: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sectionHeaderActionGlyph: { color: hull.accent },
    sectionCount: { ...hull.type.meta, color: hull.ledgerQuiet, marginRight: hull.space.sm },
  };
});
