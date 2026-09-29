import React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { CORNER_LABEL } from '@/buzz/vocabulary';
import { HullDialogInput } from './HullDialog';
import {
  HULL_SHEET_INSET,
  HullActionSheetCancel,
  HullActionSheetModal,
  HullActionSheetRow,
} from './HullActionSheet';

// Keep this local to the app bundle: mobile may run against an older built SDK
// during a rolling release. The server remains the authority for the same cap.
export const HUMAN_CORNER_TITLE_MAX_LENGTH = 120;

/**
 * The corners list + opens the same "Begin a new corner" sheet the transcript's
 * Forward uses: the title field, then one Open row and the sheet's Cancel.
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
    <HullActionSheetModal
      dismissOnBackdrop={!creating}
      onClose={onClose}
      testID="new-corner-dialog"
      title={`Begin a new ${CORNER_LABEL}`}
      visible={visible}
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
      <HullActionSheetRow
        disabled={!ready}
        label={creating ? 'Opening…' : `Open ${CORNER_LABEL}`}
        onPress={onCreate}
        testID="create-corner-submit"
      />
      <HullActionSheetCancel
        onPress={creating ? () => undefined : onClose}
        testID="create-corner-cancel"
      />
    </HullActionSheetModal>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    titleField: { paddingHorizontal: HULL_SHEET_INSET, paddingBottom: hull.space.sm },
    error: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.dialogDanger,
      marginTop: hull.space.sm,
    },
  };
});
