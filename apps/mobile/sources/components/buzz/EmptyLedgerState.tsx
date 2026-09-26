import React from 'react';
import { Pressable, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { RoomGlyph } from '@/components/buzz/RoomGlyph';
import { Typography } from '@/constants/Typography';

export type EmptyLedgerVariant = 'room' | 'corner' | 'dm';

export type EmptyLedgerStarterPrompt = {
  /** The verb, in brass: "Ask an agent". */
  lead: string;
  /** What it is for: "to turn an idea into a plan". */
  detail: string;
  onPress: () => void;
  testID?: string;
};

type EmptyLedgerStateProps = {
  variant: EmptyLedgerVariant;
  name?: string;
  objective?: string;
  onPress: () => void;
  /** A Room the viewer can write in, empty: teach by doing (first Room). */
  starterPrompts?: readonly EmptyLedgerStarterPrompt[];
  testID?: string;
};

function emptyLedgerCopy(
  variant: EmptyLedgerVariant,
  name?: string,
  objective?: string,
): { glyph: string | null; title: string; body: string } {
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
    glyph: null,
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
  starterPrompts,
  testID = 'empty-ledger-state',
}: EmptyLedgerStateProps) {
  const copy = emptyLedgerCopy(variant, name, objective);
  if (variant === 'room' && starterPrompts?.length) {
    return (
      <View style={styles.pressable} testID={testID}>
        <View style={styles.content}>
          <RoomGlyph size={28} />
          <Text style={styles.title}>Start with real work.</Text>
          <Text style={styles.body}>
            Ask an agent, open a corner for a bounded task, or invite a collaborator into this Room.
          </Text>
          <View style={styles.prompts}>
            {starterPrompts.map((prompt) => (
              <Pressable
                accessibilityLabel={`${prompt.lead} ${prompt.detail}`}
                accessibilityRole="button"
                key={prompt.lead}
                onPress={prompt.onPress}
                style={({ pressed }) => [styles.prompt, pressed && styles.promptPressed]}
                testID={prompt.testID}
              >
                <Text style={styles.promptText}>
                  <Text style={styles.promptLead}>{prompt.lead}</Text> {prompt.detail}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      </View>
    );
  }
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
        {copy.glyph ? (
          <Text accessibilityElementsHidden style={styles.glyph}>
            {copy.glyph}
          </Text>
        ) : (
          <RoomGlyph size={28} />
        )}
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
  prompts: { alignSelf: 'stretch', gap: theme.buzz.space.sm, marginTop: theme.buzz.space.lg },
  prompt: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: theme.buzz.space.md,
    paddingVertical: theme.buzz.space.sm,
    borderRadius: theme.buzz.radius,
    borderWidth: 1,
    borderColor: theme.buzz.border,
    backgroundColor: theme.buzz.bgRaised,
  },
  promptPressed: { backgroundColor: theme.buzz.bgPressed },
  promptText: { ...Typography.default(), ...theme.buzz.type.meta, color: theme.buzz.textSecondary },
  promptLead: { ...theme.buzz.type.meta, color: theme.buzz.accent },
}));
