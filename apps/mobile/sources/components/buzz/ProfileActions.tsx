import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

export type ProfileAction = {
  readonly disabled?: boolean;
  readonly label: string;
  readonly onPress: () => void;
  readonly testID?: string;
};

/** Compact identity actions shared by human and agent profiles. */
export function ProfileActions({ actions }: { readonly actions: readonly ProfileAction[] }) {
  return (
    <View style={styles.actions} testID="profile-actions">
      {actions.map((action) => (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityState={{ disabled: Boolean(action.disabled) }}
          disabled={action.disabled}
          key={action.testID ?? action.label}
          onPress={action.onPress}
          style={[styles.action, action.disabled && styles.disabled]}
          testID={action.testID}
        >
          <Text style={styles.label}>{action.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  actions: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.buzz.space.sm,
    justifyContent: 'center',
  },
  action: {
    alignItems: 'center',
    backgroundColor: theme.buzz.bgBase,
    borderColor: theme.buzz.borderStrong,
    borderRadius: theme.buzz.radius,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 76,
    paddingHorizontal: theme.buzz.space.md,
  },
  disabled: { opacity: 0.45 },
  label: {
    ...Typography.default('semiBold'),
    ...theme.buzz.type.meta,
    color: theme.buzz.accent,
  },
}));
