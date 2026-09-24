import React from 'react';
import { Pressable, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { StyleSheet } from 'react-native-unistyles';
import { ChevronGlyph } from './ChevronGlyph';
import { DECORATIVE_GLYPH_PROPS } from './decorative-glyph';

export function NoMatchingConversationsEmpty({ onShowAll }: { onShowAll: () => void }) {
  return (
    <View style={styles.empty} testID="room-list-no-match">
      <Svg {...DECORATIVE_GLYPH_PROPS} width={34} height={34} viewBox="0 0 24 24">
        <Circle
          cx={10.5}
          cy={10.5}
          r={6}
          fill="none"
          stroke={styles.actionText.color}
          strokeWidth={1.6}
        />
        <Path d="M15 15l5 5" fill="none" stroke={styles.actionText.color} strokeWidth={1.6} />
      </Svg>
      <Text style={styles.title}>No matching conversations</Text>
      <Text style={styles.copy}>Try a different search or filter.</Text>
      <Pressable
        accessibilityRole="button"
        onPress={onShowAll}
        style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        testID="no-match-show-all-conversations"
      >
        <Text style={styles.actionText}>Show all conversations</Text>
        <ChevronGlyph direction="right" size={18} color={styles.actionText.color} />
      </Pressable>
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  empty: { alignItems: 'center', paddingHorizontal: 20, paddingVertical: 72, gap: 24 },
  title: {
    ...theme.buzz.type.bodyStrong,
    color: theme.buzz.textPrimary,
    textAlign: 'center',
    fontSize: 22,
    lineHeight: 30,
  },
  copy: {
    ...theme.buzz.type.meta,
    color: theme.buzz.ledgerQuiet,
    textAlign: 'center',
    lineHeight: 24,
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: theme.buzz.accent,
    borderRadius: theme.buzz.radius,
  },
  actionText: { ...theme.buzz.type.meta, color: theme.buzz.accent },
  pressed: { backgroundColor: theme.buzz.bgPressed },
}));
