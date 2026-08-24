import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

export type EmptyLedgerVariant = 'room' | 'corner' | 'dm';

type EmptyLedgerStateProps = {
  variant: EmptyLedgerVariant;
  name?: string;
  objective?: string;
  onPress: () => void;
  testID?: string;
};

function emptyLedgerCopy(
  variant: EmptyLedgerVariant,
  name?: string,
  objective?: string,
): { glyph: string; title: string; body: string } {
  if (variant === 'corner') {
    return {
      glyph: '△',
      title: 'Ready for a steering message',
      body: objective
        ? `Steer the agent on “${objective}”.`
        : 'Tell the agent what to investigate or change.',
    };
  }
  if (variant === 'dm') {
    const person = name?.trim() || 'this person';
    return {
      glyph: '○',
      title: `Start with ${person}`,
      body: `Send ${person} the first message.`,
    };
  }
  return {
    glyph: '⌑',
    title: 'Nothing in the log yet',
    body: 'Start with the work, question, or decision this Room is for.',
  };
}

/**
 * Empty transcript voice for Room, Corner, and DM ledgers. The whole state is
 * the affordance: tapping it focuses the composer, so no duplicate button is
 * introduced beside the actual next action.
 */
export function EmptyLedgerState({
  variant,
  name,
  objective,
  onPress,
  testID = 'empty-ledger-state',
}: EmptyLedgerStateProps) {
  const copy = emptyLedgerCopy(variant, name, objective);
  return (
    <TouchableOpacity
      accessibilityHint="Focuses the message composer"
      accessibilityLabel={`${copy.title}. ${copy.body}`}
      accessibilityRole="button"
      activeOpacity={0.72}
      onPress={onPress}
      style={styles.pressable}
      testID={testID}
    >
      <View style={styles.content}>
        <Text accessibilityElementsHidden style={styles.glyph}>
          {copy.glyph}
        </Text>
        <Text style={styles.title}>{copy.title}</Text>
        <Text style={styles.body}>{copy.body}</Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create((theme) => ({
  pressable: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 24,
  },
  content: {
    width: '100%',
    maxWidth: 360,
    alignItems: 'center',
  },
  glyph: {
    ...Typography.mono('semiBold'),
    color: theme.buzz.chrome,
    fontSize: 22,
    lineHeight: 28,
  },
  title: {
    ...Typography.default('semiBold'),
    fontFamily: theme.buzz.proseSemibold,
    marginTop: 12,
    color: theme.buzz.textPrimary,
    fontSize: 16,
    lineHeight: 21,
    textAlign: 'center',
  },
  body: {
    ...Typography.default(),
    fontFamily: theme.buzz.proseRegular,
    marginTop: 7,
    color: theme.buzz.textSecondary,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
  },
}));
