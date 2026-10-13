import React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Button } from './Button';
import { HullDialogActions } from './HullDialog';

export type ProfileAction = {
  readonly disabled?: boolean;
  readonly label: string;
  readonly onPress: () => void;
  readonly testID?: string;
};

/** Profile navigation retains its layout; editing uses the shared decision row. */
export function ProfileActions({ actions }: { readonly actions: readonly ProfileAction[] }) {
  const editing = actions.some((action) => action.label === 'Cancel');
  if (!editing)
    return (
      <View style={styles.actions} testID="profile-actions">
        {actions.map((action) => (
          <Button
            key={action.testID ?? action.label}
            {...action}
            variant="brass"
            style={styles.action}
          />
        ))}
      </View>
    );
  return (
    <View testID="profile-actions">
      {actions
        .filter((action) => action.label === 'Message')
        .map((action) => (
          <Button
            key={action.testID ?? action.label}
            {...action}
            variant="brass"
            style={styles.navigation}
          />
        ))}
      <HullDialogActions
        actions={actions
          .filter((action) => action.label !== 'Message')
          .map((action) => ({
            ...action,
            variant: action.label === 'Cancel' ? 'quiet' : 'primary',
          }))}
      />
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
  navigation: { minWidth: 76, alignSelf: 'center' },
}));
