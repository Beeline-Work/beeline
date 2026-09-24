import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { PinGlyph } from './PinGlyph';
import { ChevronGlyph } from './ChevronGlyph';

export function PinnedConversationsEmpty({
  onShowAll,
  desktop = false,
}: {
  onShowAll: () => void;
  desktop?: boolean;
}) {
  return (
    <View style={styles.empty} testID={desktop ? 'desktop-pinned-empty' : 'pinned-empty'}>
      <PinGlyph color={styles.actionText.color} size={34} />
      <Text style={styles.title}>Your closest conversations,{'\n'}one tap away.</Text>
      <Text style={styles.copy}>
        No pinned conversations yet.{'\n'}Long press a Room to pin it here.
      </Text>
      <Pressable
        accessibilityRole="button"
        onPress={onShowAll}
        style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        testID={desktop ? 'desktop-show-all-conversations' : 'show-all-conversations'}
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
