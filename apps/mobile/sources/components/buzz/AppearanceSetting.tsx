import React, { useState } from 'react';
import type { LocalSettings } from '@/sync/localSettings';
import { SettingsRow } from './SettingsRow';
import { HullActionSheetCancel, HullActionSheetModal, HullActionSheetRow } from './HullActionSheet';

type Appearance = LocalSettings['appearance'];

const APPEARANCE_OPTIONS: readonly Appearance[] = ['dark', 'light'];
const APPEARANCE_LABELS: Readonly<Record<Appearance, string>> = {
  dark: 'Dark',
  light: 'Light',
};

type Props = {
  onChange: (appearance: Appearance) => void;
  value: Appearance;
};

export function AppearanceSetting({ onChange, value }: Props) {
  const [open, setOpen] = useState(false);

  const choose = (appearance: Appearance) => {
    setOpen(false);
    if (appearance === value) return;
    onChange(appearance);
  };

  return (
    <>
      <SettingsRow
        accessibilityLabel={`Appearance. ${APPEARANCE_LABELS[value]}`}
        chevron="right"
        onPress={() => setOpen(true)}
        testID="appearance-setting"
        title="Appearance"
        value={APPEARANCE_LABELS[value]}
      />
      <HullActionSheetModal
        accessibilityLabel="Close appearance picker"
        onClose={() => setOpen(false)}
        testID="appearance-sheet"
        title="Appearance"
        visible={open}
      >
        {APPEARANCE_OPTIONS.map((appearance) => (
          <HullActionSheetRow
            key={appearance}
            label={APPEARANCE_LABELS[appearance]}
            onPress={() => choose(appearance)}
            selected={value === appearance}
            testID={`appearance-${appearance}`}
          />
        ))}
        <HullActionSheetCancel onPress={() => setOpen(false)} testID="appearance-close" />
      </HullActionSheetModal>
    </>
  );
}
