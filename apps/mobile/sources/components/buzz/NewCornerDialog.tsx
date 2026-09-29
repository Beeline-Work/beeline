import React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { CORNER_LABEL } from '@/buzz/vocabulary';
import { HullDialog, HullDialogInput } from './HullDialog';

// Keep this local to the app bundle: mobile may run against an older built SDK
// during a rolling release. The server remains the authority for the same cap.
export const HUMAN_CORNER_TITLE_MAX_LENGTH = 120;

/**
 * A title-entry dialog for callers that need a human-named corner.
 */
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
      dismissOnBackdrop={!creating}
      onRequestClose={creating ? () => undefined : onClose}
      testID="new-corner-dialog"
      title={`Begin a new ${CORNER_LABEL}`}
      visible={visible}
      actions={[
        { label: 'Cancel', onPress: onClose, disabled: creating, testID: 'create-corner-cancel' },
        {
          label: creating ? 'Opening…' : `Open ${CORNER_LABEL}`,
          onPress: onCreate,
          disabled: !ready,
          busy: creating,
          variant: 'primary',
          testID: 'create-corner-submit',
        },
      ]}
    >
      <View style={styles.titleField} testID="create-corner-content">
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
      </View>
    </HullDialog>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    titleField: { paddingBottom: hull.space.sm },
    error: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.dialogDanger,
      marginTop: hull.space.sm,
    },
  };
});
