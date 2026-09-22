import React from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { HullDialog, HullDialogInput } from './HullDialog';
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
    </HullDialog>
  );
}

const styles = StyleSheet.create((theme) => ({
  appField: { marginTop: theme.buzz.space.md },
  label: {
    ...Typography.default('semiBold'),
    ...theme.buzz.type.meta,
    color: theme.buzz.textSecondary,
    marginBottom: theme.buzz.space.xs,
  },
  appRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.buzz.space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.buzz.border,
  },
  appTitle: {
    ...Typography.default(),
    ...theme.buzz.type.body,
    color: theme.buzz.textPrimary,
    flex: 1,
  },
  appMeta: { ...Typography.default(), ...theme.buzz.type.meta, color: theme.buzz.textMuted },
  guide: { minHeight: 44, justifyContent: 'center' },
  guideText: { ...Typography.default(), ...theme.buzz.type.meta, color: theme.buzz.accent },
  error: {
    ...Typography.default(),
    ...theme.buzz.type.meta,
    color: theme.buzz.danger,
    marginTop: theme.buzz.space.sm,
  },
}));
