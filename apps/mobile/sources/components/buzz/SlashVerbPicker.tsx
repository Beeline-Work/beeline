import React from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { BuiltInSlashVerb, BuiltInSlashVerbId } from '@/buzz/slash-verbs';
import type { AgentPaletteCommand } from '@/buzz/slash-verbs';
import { Typography } from '@/constants/Typography';

export function SlashVerbPicker({
  verbs,
  query,
  highlightedIndex,
  onDismiss,
  onSelect,
  /** The addressed agent's advertised commands; rendered above Beeline's built-ins. */
  commands,
  /** Display name of the agent whose commands these are (heading attribution). */
  agentName,
  /** True once the agent's published list resolved empty or absent: quiet honesty line. */
  agentLacksCommands,
  onSelectCommand,
}: {
  verbs: readonly BuiltInSlashVerb[];
  /** The slash token currently typed, without the leading `/` ('' when open on just '/'). */
  query: string;
  /** Highlight index over the COMBINED list: advertised commands first, then built-in verbs. */
  highlightedIndex: number;
  onDismiss: () => void;
  onSelect: (id: BuiltInSlashVerbId) => void;
  commands?: readonly AgentPaletteCommand[];
  agentName?: string;
  agentLacksCommands?: boolean;
  onSelectCommand: (name: string) => void;
}) {
  const commandCount = commands?.length ?? 0;
  const heading = agentName ? `COMMANDS · ${agentName.toUpperCase()}` : 'COMMANDS';
  return (
    <View accessibilityLabel="Available commands" style={styles.root} testID="slash-verb-picker">
      <View style={styles.heading}>
        <Text numberOfLines={1} style={styles.headingText}>
          {heading}
        </Text>
        <TouchableOpacity
          accessibilityLabel="Dismiss commands"
          accessibilityRole="button"
          onPress={onDismiss}
          style={styles.dismiss}
          testID="slash-verb-dismiss"
        >
          <Text style={styles.dismissText}>×</Text>
        </TouchableOpacity>
      </View>
      {commandCount > 0 || verbs.length > 0 ? (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          style={styles.list}
        >
          {agentLacksCommands && commandCount === 0 ? (
            <View style={styles.quietWrap} testID="slash-agent-no-commands">
              <Text style={styles.empty} numberOfLines={2}>
                {agentName
                  ? `${agentName.toUpperCase()} DOES NOT ADVERTISE COMMANDS`
                  : 'THIS AGENT DOES NOT ADVERTISE COMMANDS'}
              </Text>
            </View>
          ) : null}
          {(commands ?? []).map((command, index) => {
            const selected = index === highlightedIndex;
            return (
              <TouchableOpacity
                accessibilityLabel={`/${command.name}. ${command.description ?? 'Advertised command'}`}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                key={`command:${command.name}`}
                onPress={() => onSelectCommand(command.name)}
                style={[styles.row, styles.commandRow, selected && styles.rowSelected]}
                testID={`slash-agent-command-${command.name}`}
              >
                <Text numberOfLines={1} style={[styles.command, styles.agentCommand]}>
                  /{command.name}
                </Text>
                <View style={styles.copy}>
                  {command.description ? (
                    <Text numberOfLines={2} style={styles.description}>
                      {command.description}
                    </Text>
                  ) : null}
                  {command.inputHint ? (
                    <Text numberOfLines={1} style={styles.label}>
                      {command.inputHint}
                    </Text>
                  ) : null}
                </View>
                <Text style={styles.enter}>↵</Text>
              </TouchableOpacity>
            );
          })}
          {verbs.map((verb, verbIndex) => {
            const index = commandCount + verbIndex;
            const selected = index === highlightedIndex;
            return (
              <TouchableOpacity
                accessibilityLabel={`/${verb.command}. ${verb.description}`}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                key={verb.id}
                onPress={() => onSelect(verb.id)}
                style={[styles.row, selected && styles.rowSelected]}
                testID={`slash-verb-${verb.id}`}
              >
                <Text numberOfLines={1} style={styles.command}>
                  /{verb.command}
                </Text>
                <View style={styles.copy}>
                  <Text numberOfLines={1} style={styles.label}>
                    {verb.label}
                  </Text>
                  <Text numberOfLines={2} style={styles.description}>
                    {verb.description}
                  </Text>
                </View>
                <Text style={styles.enter}>↵</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      ) : (
        // An unrecognized verb is a NAMED dead end now: it used to just say
        // NO MATCHING COMMANDS with send disabled, so nothing explained that
        // `/loop` was never one of Beeline's words — and sending anyway is
        // allowed, visibly marked by the daemon as passed through.
        <View style={styles.emptyWrap} testID="slash-verb-no-match">
          <Text style={styles.empty}>
            {query ? `/${query} IS NOT A BEELINE COMMAND` : 'NO MATCHING COMMANDS'}
          </Text>
          <Text style={styles.emptyHint}>
            Beeline runs its commands from this menu. Send your text anyway to pass it to the agent
            as an ordinary message.
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return ({
  root: {
    maxHeight: 276,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: groknight.border,
    borderRadius: groknight.radius,
    backgroundColor: groknight.bgBase,
    overflow: 'hidden',
  },
  heading: {
    minHeight: 34,
    paddingLeft: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: 1,
    borderBottomColor: groknight.borderQuiet,
  },
  headingText: {
    ...Typography.mono('semiBold'),
    color: groknight.textMuted,
    fontSize: 9,
    letterSpacing: 1.3,
  },
  dismiss: {
    width: 44,
    minHeight: 34,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dismissText: {
    ...Typography.default(),
    color: groknight.textSecondary,
    fontSize: 18,
  },
  list: { maxHeight: 240 },
  row: {
    minHeight: 58,
    paddingHorizontal: 12,
    paddingVertical: 9,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: groknight.borderQuiet,
  },
  rowSelected: { backgroundColor: groknight.bgHover },
  command: {
    ...Typography.mono('semiBold'),
    width: 138,
    color: groknight.textPrimary,
    fontSize: 11,
  },
  commandRow: { minHeight: 46 },
  agentCommand: {
    color: groknight.accent,
  },
  copy: { flex: 1, minWidth: 0 },
  label: {
    ...Typography.default('semiBold'),
    color: groknight.textSecondary,
    fontSize: 11,
    lineHeight: 15,
  },
  description: {
    ...Typography.default(),
    color: groknight.textMuted,
    fontSize: 10,
    lineHeight: 14,
  },
  enter: {
    ...Typography.mono(),
    color: groknight.textDisabled,
    fontSize: 12,
  },
  empty: {
    ...Typography.mono(),
    paddingHorizontal: 12,
    paddingTop: 14,
    color: groknight.textMuted,
    fontSize: 10,
  },
  emptyWrap: { paddingHorizontal: 12, paddingVertical: 12 },
  quietWrap: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: groknight.borderQuiet,
  },
  emptyHint: {
    ...Typography.default(),
    color: groknight.textMuted,
    fontSize: 10,
    lineHeight: 14,
    marginTop: 4,
  },
  });
});
