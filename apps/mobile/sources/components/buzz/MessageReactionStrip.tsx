import React from 'react';
import { Pressable, ScrollView, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { MESSAGE_REACTION_EMOJIS, type MessageReactionEmoji } from '@beeline/buzz-client';
import { Typography } from '@/constants/Typography';
import { HULL_SHEET_INSET } from './HullActionSheet';

/** The strip's cap. It scrolls, so the vocabulary may grow — it never grows
 *  past twelve choices. */
export const MAX_MESSAGE_REACTIONS = 12;

/**
 * The message actions sheet's reaction entry point: a plain horizontal
 * scrolling strip of emoji as the sheet's top cell. There is no React button
 * and nothing to expand — the emoji themselves are the whole affordance.
 */
export function MessageReactionStrip({ onReact }: { onReact(emoji: MessageReactionEmoji): void }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.content}
      style={styles.strip}
      testID="message-reaction-strip"
    >
      {MESSAGE_REACTION_EMOJIS.slice(0, MAX_MESSAGE_REACTIONS).map((emoji) => (
        <Pressable
          accessibilityLabel={`React with ${emoji}`}
          accessibilityRole="button"
          key={emoji}
          onPress={() => onReact(emoji)}
          style={({ pressed }) => [styles.choice, pressed && styles.choicePressed]}
          testID={`message-reaction-${emoji}`}
        >
          <Text style={styles.emoji}>{emoji}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return {
    strip: {
      flexGrow: 0,
    },
    content: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: groknight.space.sm,
      paddingHorizontal: HULL_SHEET_INSET,
      paddingVertical: groknight.space.sm,
    },
    choice: {
      minWidth: 44,
      minHeight: 36,
      alignItems: 'center',
      justifyContent: 'center',
    },
    choicePressed: { backgroundColor: groknight.bgHighlight },
    emoji: {
      ...Typography.default(),
      ...groknight.type.body,
      lineHeight: 22,
    },
  };
});
