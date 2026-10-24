import { Button } from '@/components/buzz/Button';
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
      <Button
        accessibilityRole="button"
        onPress={onShowAll}
        testID={desktop ? 'desktop-show-all-conversations' : 'show-all-conversations'}
        label={'Show all conversations'}
        variant="quiet"
        iconPosition="end"
        icon={
          <>
            <ChevronGlyph direction="right" size={18} color={styles.actionText.color} />
          </>
        }
        appearance={{
          control: ({ pressed }) => [styles.action, pressed && styles.pressed],
          label: styles.actionText,
        }}
      />
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  empty: { alignItems: 'center', paddingHorizontal: theme.buzz.space.lg, paddingVertical: theme.buzz.space.xxl, gap: 24 },
  title: {
    ...theme.buzz.type.hero,
    color: theme.buzz.textPrimary,
    textAlign: 'center',
  },
  copy: {
    ...theme.buzz.type.meta,
    color: theme.buzz.ledgerQuiet,
    textAlign: 'center',
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.buzz.space.sm,
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: theme.buzz.space.sm,
    borderWidth: 1,
    borderColor: theme.buzz.buttonSecondaryText,
    borderRadius: theme.buzz.radius,
  },
  actionText: { ...theme.buzz.type.meta, color: theme.buzz.buttonSecondaryText },
  pressed: { backgroundColor: theme.buzz.bgPressed },
}));
