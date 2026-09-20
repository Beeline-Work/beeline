import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { PUSH_LEVELS, type PushLevel } from '@beeline/api-contract/phone';
import { SettingsRow } from './SettingsRow';
import { HullActionSheetCancel, HullActionSheetModal, HullActionSheetRow } from './HullActionSheet';

export const PUSH_LEVEL_LABELS: Readonly<Record<PushLevel, string>> = {
  off: 'Off',
  direct: 'Direct messages and mentions',
  mine: 'Direct messages, mentions, and my corners',
  all: 'Everything',
};
const PUSH_LEVEL_VALUES: Readonly<Record<PushLevel, string>> = {
  off: 'Off',
  direct: 'Direct',
  mine: 'My corners',
  all: 'Everything',
};

type Props = {
  disabled?: boolean;
  onSave: (level: PushLevel) => Promise<unknown>;
  value: PushLevel;
};

export function PushLevelSetting({ disabled = false, onSave, value }: Props) {
  const [open, setOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async (level: PushLevel) => {
    if (working) return;
    if (level === value) {
      setOpen(false);
      return;
    }
    setWorking(true);
    setError(null);
    try {
      await onSave(level);
      setOpen(false);
    } catch (caught) {
      setError(`Could not update push notifications: ${String(caught)}`);
    } finally {
      setWorking(false);
    }
  };

  return (
    <>
      <SettingsRow
        accessibilityLabel={`Push notifications. ${PUSH_LEVEL_LABELS[value]}`}
        chevron="right"
        disabled={disabled || working}
        onPress={() => {
          setError(null);
          setOpen(true);
        }}
        testID="push-notifications-setting"
        title="Notifications"
        value={PUSH_LEVEL_VALUES[value]}
      />
      <HullActionSheetModal
        accessibilityLabel="Close push notifications picker"
        dismissOnBackdrop={!working}
        onClose={() => {
          if (!working) setOpen(false);
        }}
        testID="push-notifications-sheet"
        title="Push notifications"
        visible={open}
      >
        {PUSH_LEVELS.map((level) => (
          <HullActionSheetRow
            disabled={working}
            key={level}
            label={PUSH_LEVEL_LABELS[level]}
            onPress={() => void choose(level)}
            selected={value === level}
            testID={`push-level-${level}`}
          />
        ))}
        {error ? (
          <View accessibilityRole="alert" style={styles.error} testID="push-level-error">
            <Text style={styles.errorText}>! {error}</Text>
          </View>
        ) : null}
        <HullActionSheetCancel onPress={() => setOpen(false)} testID="push-level-close" />
      </HullActionSheetModal>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  error: {
    borderTopColor: theme.buzz.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  errorText: { ...theme.buzz.type.meta, color: theme.buzz.danger },
}));
