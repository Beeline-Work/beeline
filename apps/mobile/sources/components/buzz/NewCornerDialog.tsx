import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { HullDialogInput } from './HullDialog';
import { HULL_SHEET_INSET, HullActionSheetModal } from './HullActionSheet';

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
    <HullActionSheetModal
      dismissOnBackdrop={!creating}
      onClose={onClose}
      testID="new-corner-dialog"
      title="New corner"
      visible={visible}
      footer={
        <View style={styles.actions}>
          <TouchableOpacity
            accessibilityRole="button"
            disabled={creating}
            onPress={onClose}
            style={styles.cancelAction}
            testID="create-corner-cancel"
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityState={{ busy: creating, disabled: !ready }}
            disabled={!ready}
            onPress={onCreate}
            style={[styles.primaryAction, !ready && styles.disabledAction]}
            testID="create-corner-submit"
          >
            <Text style={styles.primaryActionText}>{creating ? 'Creating…' : 'Create'}</Text>
          </TouchableOpacity>
        </View>
      }
    >
      <View style={styles.form} testID="create-corner-content">
        <View style={styles.titleField}>
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
        </View>
        {error ? (
          <Text accessibilityRole="alert" style={styles.error} testID="create-corner-error">
            {error}
          </Text>
        ) : null}
      </View>
    </HullActionSheetModal>
  );
}

const styles = StyleSheet.create((theme) => {
  const hull = theme.buzz;
  return {
    form: { paddingTop: 14 },
    titleField: { paddingHorizontal: HULL_SHEET_INSET, paddingBottom: 16 },
    error: {
      ...Typography.default(),
      ...hull.type.meta,
      color: hull.dialogDanger,
      marginHorizontal: HULL_SHEET_INSET,
      marginTop: hull.space.sm,
    },
    actions: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: HULL_SHEET_INSET,
      paddingTop: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: hull.border,
    },
    cancelAction: { minHeight: 44, flex: 1, justifyContent: 'center', alignItems: 'center' },
    cancelText: { ...Typography.default(), ...hull.type.body, color: hull.chrome },
    primaryAction: {
      minHeight: 44,
      minWidth: 118,
      paddingHorizontal: 14,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: hull.radius,
      backgroundColor: hull.accent,
    },
    disabledAction: { opacity: 0.42 },
    primaryActionText: { ...Typography.default('semiBold'), color: hull.textInverted },
  };
});
