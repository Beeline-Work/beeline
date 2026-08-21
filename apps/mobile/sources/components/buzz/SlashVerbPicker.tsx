import React from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { BuiltInSlashVerb, BuiltInSlashVerbId } from '@/buzz/slash-verbs';
import { Typography } from '@/constants/Typography';

export function SlashVerbPicker({
  verbs,
  highlightedIndex,
  onDismiss,
  onSelect,
}: {
  verbs: readonly BuiltInSlashVerb[];
  highlightedIndex: number;
  onDismiss: () => void;
  onSelect: (id: BuiltInSlashVerbId) => void;
}) {
  return (
    <View accessibilityLabel="Available commands" style={styles.root} testID="slash-verb-picker">
      <View style={styles.heading}>
        <Text style={styles.headingText}>COMMANDS</Text>
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
      {verbs.length ? (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          style={styles.list}
        >
          {verbs.map((verb, index) => {
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
        <Text style={styles.empty}>NO MATCHING COMMANDS</Text>
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
    paddingVertical: 18,
    color: groknight.textMuted,
    fontSize: 10,
  },
  });
});
