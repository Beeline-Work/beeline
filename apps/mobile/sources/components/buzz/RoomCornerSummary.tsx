import React from 'react';
import { Pressable, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { ChevronGlyph } from './ChevronGlyph';

export function RoomCornerSummary({
  count,
  waiting,
  expanded,
  onPress,
  testID,
}: {
  count: number;
  waiting?: number;
  expanded?: boolean;
  onPress: () => void;
  testID: string;
}) {
  const corners = `${count} ${count === 1 ? 'corner' : 'corners'}`;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${expanded === undefined ? 'Open' : expanded ? 'Hide' : 'Show'} ${corners}${waiting ? `, ${waiting} waiting` : ''}`}
      accessibilityState={expanded === undefined ? undefined : { expanded }}
      style={styles.row}
      testID={testID}
    >
      <Text style={styles.text}>
        {Boolean(waiting) && <Text style={styles.waiting}>{waiting} waiting · </Text>}
        {corners}
      </Text>
      <ChevronGlyph
        size={16}
        color={styles.text.color}
        direction={expanded === undefined ? 'right' : expanded ? 'up' : 'down'}
      />
    </Pressable>
  );
}
const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    paddingHorizontal: theme.buzz.space.md,
    paddingBottom: theme.buzz.space.sm,
    gap: theme.buzz.space.sm,
  },
  text: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet, flex: 1 },
  waiting: { color: theme.buzz.accent },
}));
