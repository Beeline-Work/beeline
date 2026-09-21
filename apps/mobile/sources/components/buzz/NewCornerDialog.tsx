import React from 'react';
import { Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { HullDialog, HullDialogInput } from './HullDialog';

// Keep this local to the app bundle: mobile may run against an older built SDK
// during a rolling release. The server remains the authority for the same cap.
export const HUMAN_CORNER_TITLE_MAX_LENGTH = 120;

export function NewCornerDialog({
  visible,
  title,
  setTitle,
  creating,
  error,
  onCreate,
  onClose,
}: {
  visible: boolean;
  title: string;
  setTitle: (title: string) => void;
  creating: boolean;
  error?: string | null;
  onCreate: () => void;
  onClose: () => void;
}) {
  const ready = Boolean(title.trim()) && !creating;
  return (
    <HullDialog
      actions={[
        { label: 'Cancel', onPress: onClose },
        {
          label: creating ? 'Creating' : 'Create',
          busy: creating,
          disabled: !ready,
          onPress: onCreate,
          testID: 'create-corner-submit',
          variant: 'primary',
        },
      ]}
      body="A human-owned corner stays open until you close it."
      onRequestClose={onClose}
      testID="new-corner-dialog"
      title="New corner"
      visible={visible}
    >
      <HullDialogInput
        accessibilityLabel="Corner title"
        autoFocus
        editable={!creating}
        maxLength={HUMAN_CORNER_TITLE_MAX_LENGTH}
        onChangeText={setTitle}
        onSubmitEditing={ready ? onCreate : undefined}
        placeholder="Corner title"
        returnKeyType="done"
        testID="create-corner-title"
        value={title}
      />
      {error ? (
        <Text accessibilityRole="alert" style={styles.error} testID="create-corner-error">
          {error}
        </Text>
      ) : null}
    </HullDialog>
  );
}

const styles = StyleSheet.create((theme) => ({
  error: {
    ...Typography.default(),
    ...theme.buzz.type.meta,
    color: theme.buzz.danger,
    marginTop: theme.buzz.space.sm,
  },
}));
