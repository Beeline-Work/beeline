import React, { useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import Svg, { Circle, Path } from 'react-native-svg';

/**
 * A phone menu's standing search row: the magnifier, the field, and a clear
 * button once there is something to clear. One hairline under it, brass while
 * the field has focus.
 */
export function SearchField({
  value,
  onChangeText,
  label,
  testID,
}: {
  value: string;
  onChangeText: (value: string) => void;
  /** Both the placeholder and the accessible name. */
  label: string;
  testID: string;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={[styles.row, focused && styles.focused]}>
      <Svg height={18} viewBox="0 0 24 24" width={18}>
        <Circle
          cx={10.5}
          cy={10.5}
          fill="none"
          r={6.5}
          stroke={styles.icon.color}
          strokeWidth={1.8}
        />
        <Path
          d="M15.5 15.5L20 20"
          stroke={styles.icon.color}
          strokeLinecap="round"
          strokeWidth={1.8}
        />
      </Svg>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        accessibilityLabel={label}
        placeholder={label}
        placeholderTextColor={styles.icon.color}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={styles.input}
        testID={testID}
      />
      {value ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          onPress={() => onChangeText('')}
          style={styles.clear}
          testID={`${testID}-clear`}
        >
          <Svg height={18} viewBox="0 0 24 24" width={18}>
            <Path
              d="M6 6l12 12M18 6L6 18"
              stroke={styles.icon.color}
              strokeLinecap="round"
              strokeWidth={1.8}
            />
          </Svg>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: theme.buzz.space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.buzz.border,
  },
  focused: { borderBottomColor: theme.buzz.accent },
  icon: { color: theme.buzz.ledgerQuiet },
  input: {
    ...theme.buzz.type.body,
    flex: 1,
    color: theme.buzz.textPrimary,
    paddingVertical: theme.buzz.space.sm,
    paddingHorizontal: theme.buzz.space.sm,
    minHeight: 44,
  },
  clear: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
}));
