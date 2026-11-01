import { ContentTarget } from '@/components/buzz/IndexRow';
import { CloseButton } from '@/components/buzz/CloseGlyph';
import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { BuiltInSlashVerb, BuiltInSlashVerbId } from '@/buzz/slash-verbs';
import type { AgentPaletteCommand } from '@/buzz/slash-verbs';

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
        <CloseButton
          accessibilityLabel="Dismiss commands"
          onPress={onDismiss}
          testID="slash-verb-dismiss"
          control={styles.dismiss}
        />
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
              <ContentTarget
                accessibilityLabel={`/${command.name}. ${command.description ?? 'Advertised command'}`}
                accessibilityRole={command.toggle === undefined ? 'button' : 'switch'}
                accessibilityState={
                  command.toggle === undefined
                    ? { selected }
                    : { selected, checked: command.toggle }
                }
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
                {command.toggle === undefined ? (
                  <Text style={styles.enter}>↵</Text>
                ) : (
                  <Text
                    style={[styles.enter, styles.toggleState, command.toggle && styles.toggleOn]}
                    testID={`slash-agent-command-${command.name}-state`}
                  >
                    {command.toggle ? 'ON' : 'OFF'}
                  </Text>
                )}
              </ContentTarget>
            );
          })}
          {verbs.map((verb, verbIndex) => {
            const index = commandCount + verbIndex;
            const selected = index === highlightedIndex;
            return (
              <ContentTarget
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
              </ContentTarget>
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
  return {
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
      paddingLeft: 16,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderBottomWidth: 1,
      borderBottomColor: groknight.borderQuiet,
    },
    headingText: {
      ...groknight.type.sectionHead,
      color: groknight.textMuted,
    },
    dismiss: {
      width: 44,
      minHeight: 34,
      alignItems: 'center',
      justifyContent: 'center',
    },
    list: { maxHeight: 240 },
    row: {
      minHeight: 58,
      paddingHorizontal: 16,
      paddingVertical: 8,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: groknight.borderQuiet,
    },
    rowSelected: { backgroundColor: groknight.bgHover },
    // The press feedback of the touchable rows beside it.
    rowPressed: { opacity: 0.2 },
    command: {
      ...groknight.type.machine,
      fontFamily: groknight.monoSemibold,
      width: 138,
      color: groknight.textPrimary,
    },
    // Android's minimum interactive target is 48dp; iOS's 44pt floor is
    // therefore covered by the same row without adding a second platform path.
    commandRow: { minHeight: 48 },
    agentCommand: {
      color: groknight.accent,
    },
    copy: { flex: 1, minWidth: 0 },
    label: {
      ...groknight.type.meta,
      fontFamily: groknight.proseSemibold,
      color: groknight.textSecondary,
    },
    description: {
      ...groknight.type.meta,
      color: groknight.textMuted,
    },
    enter: {
      ...groknight.type.machine,
      color: groknight.textDisabled,
    },
    toggleState: { color: groknight.textMuted },
    toggleOn: { color: groknight.accent },
    empty: {
      ...groknight.type.machine,
      paddingHorizontal: 16,
      paddingTop: 16,
      color: groknight.textMuted,
    },
    emptyWrap: { paddingHorizontal: 16, paddingVertical: 16 },
    quietWrap: {
      paddingHorizontal: 16,
      paddingVertical: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: groknight.borderQuiet,
    },
    emptyHint: {
      ...groknight.type.meta,
      color: groknight.textMuted,
      marginTop: 4,
    },
  };
});
