import { EmptyState } from './EmptyState';
import { IndexRow } from './IndexRow';
import React from 'react';
import { View } from 'react-native';
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
  agentHandle?: string;
  onPress: () => void;
  /** A Room the viewer can write in, empty: teach by doing (first Room). */
  starterPrompts?: readonly EmptyLedgerStarterPrompt[];
  /** The line under the starter title (`roomStarterIntro`). */
  starterIntro?: string;
  testID?: string;
};

function emptyLedgerCopy(
  variant: EmptyLedgerVariant,
  name?: string,
  agentHandle?: string,
): { glyph: string | null; title: string; body: string } {
  if (variant === 'corner') {
    return {
      glyph: '△',
      title: agentHandle ? `Tag @${agentHandle.replace(/^@/, '')} to start` : 'Tag an agent to start',
      body: 'Agents here reply only when tagged.',
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

/** Opening records are retained, but do not count as a conversation to start. */
export function cornerNeedsStarter(rows: readonly { systemEvent?: { kind?: string } }[]): boolean {
  return rows.every((row) =>
    row.systemEvent?.kind === 'corner-opened' || row.systemEvent?.kind === 'workflow-handoff',
  );
}

/** Shared empty-state copy and actions for Room, Corner and DM ledgers. */
export function EmptyLedgerState({
  variant,
  name,
  agentHandle,
  onPress,
  starterPrompts,
  starterIntro,
  testID = 'empty-ledger-state',
}: EmptyLedgerStateProps) {
  const copy = emptyLedgerCopy(variant, name, agentHandle);
  if (variant === 'room' && starterPrompts?.length) {
    return (
      <View style={styles.pressable} testID={testID}>
        <View style={styles.content}>
          <RoomGlyph size={28} />
          <EmptyState title={name ? `${name} is empty` : 'This Room is empty'} description={starterIntro} />
          <View style={styles.prompts}>
            {starterPrompts.map((prompt) => (
              <IndexRow key={prompt.lead} title={prompt.lead} description={prompt.detail} accessibilityLabel={`${prompt.lead} ${prompt.detail}`}
                onPress={prompt.onPress} testID={prompt.testID} />
            ))}
          </View>
        </View>
      </View>
    );
  }
  return (
    <View style={styles.pressable} testID={testID}>
      <EmptyState title={copy.title} description={copy.body}
        action={{label:copy.title, onPress, accessibilityLabel:`${copy.title}. ${copy.body}`}} />
    </View>
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
  prompts: { alignSelf: 'stretch', gap: theme.buzz.space.sm, marginTop: theme.buzz.space.lg },
}));
