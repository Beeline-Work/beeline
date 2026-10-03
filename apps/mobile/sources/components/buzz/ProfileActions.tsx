import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Button } from './Button';

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
        <Button
          disabled={action.disabled}
          key={action.testID ?? action.label}
          label={action.label}
          onPress={action.onPress}
          style={styles.action}
          testID={action.testID}
          variant="brass"
        />
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
  action: { minWidth: 76 },
}));
