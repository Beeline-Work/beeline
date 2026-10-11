import React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { CORNER_META_SIZE, CornerGlyph } from './CornerGlyph';

/** The only two places a Room's scheduled work can run. */
export function ScheduledWorkWhere({ corner }: { corner?: { id: string; name: string } | null }) {
  if (!corner) return <Text numberOfLines={1} style={styles.room}>this Room</Text>;
  return <View style={styles.corner}>
    <CornerGlyph size={CORNER_META_SIZE} />
    <Text numberOfLines={1} style={styles.name}>{corner.name}</Text>
  </View>;
}

const styles = StyleSheet.create((theme) => ({
  corner: { flexDirection: 'row', alignItems: 'center', gap: theme.buzz.space.xs, flexShrink: 0, maxWidth: '75%' },
  name: { ...theme.buzz.type.meta, color: theme.buzz.textMuted, flexShrink: 1, minWidth: 0 },
  room: { ...theme.buzz.type.meta, color: theme.buzz.textMuted, flexShrink: 0 },
}));
