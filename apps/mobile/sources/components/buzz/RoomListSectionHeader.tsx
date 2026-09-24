import * as React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

import { Ionicons } from '@expo/vector-icons';
import { Pressable } from 'react-native';

export function RoomListSectionHeader({
  title,
  count,
  actionAccessibilityLabel,
  actionTestID,
  onAction,
}: {
  title: string;
  count?: number;
  actionAccessibilityLabel?: string;
  actionTestID?: string;
  onAction?: () => void;
}) {
  return (
    <View style={styles.sectionHeader}>
      <Text accessibilityRole="header" style={styles.sectionHeaderText}>
        {title.toUpperCase()}
      </Text>
      {count !== undefined && <Text style={styles.sectionCount}>{count}</Text>}
      {onAction ? (
        <Pressable
          accessibilityLabel={actionAccessibilityLabel}
          accessibilityRole="button"
          onPress={onAction}
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
      paddingTop: 20,
      paddingBottom: hull.space.xs,
      paddingHorizontal: hull.space.md,
      backgroundColor: hull.bgTerminal,
    },
    sectionHeaderText: {
      ...Typography.default('semiBold'),
      ...hull.type.sectionHead,
      color: hull.textMuted,
      flex: 1,
    },
    sectionHeaderAction: {
      minHeight: 28,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sectionHeaderActionGlyph: { color: hull.accent },
    sectionCount: { ...hull.type.meta, color: hull.ledgerQuiet, marginRight: hull.space.sm },
  };
});
