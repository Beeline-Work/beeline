import React, { useState } from 'react';
import { Platform } from 'react-native';
import type { LocalSettings } from '@/sync/localSettings';
import { APP_UI_SIZE_LABELS, APP_UI_SIZE_OPTIONS } from '@/ui-size';
import { SettingsRow } from './SettingsRow';
import { HullActionSheetCancel, HullActionSheetModal, HullActionSheetRow } from './HullActionSheet';

type UiSize = LocalSettings['uiSize'];

type Props = {
  onChange: (uiSize: UiSize) => void;
  value: UiSize;
};

export function uiSizeSettingLabel(platform: typeof Platform.OS): 'Interface size' | 'Text size' {
  return platform === 'web' ? 'Interface size' : 'Text size';
}

export function UiSizeSetting({ onChange, value }: Props) {
  const [open, setOpen] = useState(false);
  const noun = uiSizeSettingLabel(Platform.OS);

  const choose = (uiSize: UiSize) => {
    setOpen(false);
    if (uiSize === value) return;
    onChange(uiSize);
  };

  return (
    <>
      <SettingsRow
        accessibilityLabel={`${noun}. ${APP_UI_SIZE_LABELS[value]}`}
        chevron="right"
        onPress={() => setOpen(true)}
        testID="ui-size-setting"
        title={noun}
        value={APP_UI_SIZE_LABELS[value]}
      />
      <HullActionSheetModal
        accessibilityLabel={`Close ${noun.toLowerCase()} picker`}
        onClose={() => setOpen(false)}
        testID="ui-size-sheet"
        title={noun}
        visible={open}
      >
        {APP_UI_SIZE_OPTIONS.map((uiSize) => (
          <HullActionSheetRow
            key={uiSize}
            label={APP_UI_SIZE_LABELS[uiSize]}
            onPress={() => choose(uiSize)}
            selected={value === uiSize}
            testID={`ui-size-${uiSize}`}
          />
        ))}
        <HullActionSheetCancel onPress={() => setOpen(false)} testID="ui-size-close" />
      </HullActionSheetModal>
    </>
  );
}
