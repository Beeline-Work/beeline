import React from 'react';
import { Pressable, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

/** The "Mine" switch shared by the corners page and the desktop rail. */
export function MineCornersToggle({
  mine,
  onChange,
  testID,
}: {
  mine: boolean;
  onChange: (mine: boolean) => void;
  testID: string;
}) {
  return (
    <Pressable
      accessibilityLabel="Only corners you commissioned or that await you"
      accessibilityRole="switch"
      aria-checked={mine}
      onPress={() => onChange(!mine)}
      style={[styles.toggle, mine && styles.toggleOn]}
      testID={testID}
    >
      <Text style={[styles.label, mine && styles.labelOn]}>Mine</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  toggle: {
    minHeight: 28,
    minWidth: 44,
    paddingHorizontal: theme.buzz.space.sm,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.buzz.border,
  },
  toggleOn: { borderColor: theme.buzz.accent },
  label: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet },
  labelOn: { color: theme.buzz.accent },
}));
