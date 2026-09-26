import React from 'react';
import { Linking, Pressable, Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { HullDialogInput } from './HullDialog';
import { HULL_SHEET_INSET, HullActionSheetModal } from './HullActionSheet';
import type { CornerAppInstallationView } from '@beeline/api-contract/phone';

export const CORNER_APP_BUILD_GUIDE_URL =
  'https://github.com/Beeline-Work/beeline/blob/main/docs/corner-apps.md';

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
  apps = [],
  selectedAppId,
  setSelectedAppId,
}: {
  visible: boolean;
  title: string;
  setTitle: (title: string) => void;
  creating: boolean;
  error?: string | null;
  onCreate: () => void;
  onClose: () => void;
  apps?: readonly CornerAppInstallationView[];
  selectedAppId?: string;
  setSelectedAppId?: (id: string | undefined) => void;
}) {
  const ready = Boolean(title.trim()) && !creating;
  return (
    <HullActionSheetModal
      dismissOnBackdrop={!creating}
      onClose={onClose}
      subtitle="A human-owned corner stays open until you close it."
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
        <View style={styles.appField} testID="create-corner-app-field">
          <Text style={styles.label}>Corner App · optional</Text>
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ checked: !selectedAppId }}
            disabled={creating}
            onPress={() => setSelectedAppId?.(undefined)}
            style={styles.appRow}
            testID="create-corner-app-none"
          >
            <Text style={styles.appTitle}>No app</Text>
            <Text style={styles.appMeta}>
              {!selectedAppId ? 'Selected · chat corner' : 'Chat corner'}
            </Text>
          </Pressable>
          {apps.map((app) => (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ checked: selectedAppId === app.id }}
              disabled={creating}
              key={app.id}
              onPress={() => setSelectedAppId?.(app.id)}
              style={styles.appRow}
              testID={`create-corner-app-${app.id}`}
            >
              <Text style={styles.appTitle}>{app.manifest.title}</Text>
              <Text numberOfLines={1} style={styles.appMeta}>
                {selectedAppId === app.id
                  ? `Selected · ${app.manifest.developer}`
                  : app.manifest.developer}
              </Text>
            </Pressable>
          ))}
          <Pressable
            accessibilityRole="link"
            onPress={() => void Linking.openURL(CORNER_APP_BUILD_GUIDE_URL)}
            style={styles.guide}
            testID="create-corner-app-guide"
          >
            <Text style={styles.guideText}>Build a Corner App on GitHub</Text>
          </Pressable>
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
    appField: { marginTop: 0 },
    label: {
      ...Typography.default('semiBold'),
      ...hull.type.meta,
      color: hull.textSecondary,
      paddingHorizontal: HULL_SHEET_INSET,
      paddingBottom: hull.space.xs,
    },
    appRow: {
      minHeight: 44,
      flexDirection: 'row',
      alignItems: 'center',
      gap: hull.space.sm,
      paddingHorizontal: HULL_SHEET_INSET,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: hull.border,
    },
    appTitle: {
      ...Typography.default(),
      ...hull.type.body,
      color: hull.textPrimary,
      flex: 1,
    },
    appMeta: { ...Typography.default(), ...hull.type.meta, color: hull.textMuted },
    guide: {
      minHeight: 44,
      justifyContent: 'center',
      paddingHorizontal: HULL_SHEET_INSET,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: hull.border,
    },
    guideText: { ...Typography.default(), ...hull.type.meta, color: hull.accent },
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