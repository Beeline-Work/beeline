import React, { useState } from 'react';
import { SettingsRow } from './SettingsRow';
import { HullActionSheetCancel, HullActionSheetModal, HullActionSheetRow } from './HullActionSheet';

const SPEAKING_SPEED_OPTIONS = [1.15, 1.3, 1.5] as const;
const SPEAKING_SPEED_LABELS = { 1.15: 'Normal', 1.3: 'Medium', 1.5: 'Fast' };

type SpeakingSpeed = typeof SPEAKING_SPEED_OPTIONS[number];

type Props = {
  onChange: (speakingSpeed: SpeakingSpeed) => void;
  value: SpeakingSpeed;
};

export function SpeakingSpeedSetting({ onChange, value }: Props) {
  const [open, setOpen] = useState(false);
  const noun = 'Speaking speed';

  const choose = (speakingSpeed: SpeakingSpeed) => {
    setOpen(false);
    if (speakingSpeed === value) return;
    onChange(speakingSpeed);
  };

  return (
    <>
      <SettingsRow
        accessibilityLabel={`${noun}. ${SPEAKING_SPEED_LABELS[value]}`}
        chevron="right"
        onPress={() => setOpen(true)}
        testID="speaking-speed-setting"
        title={noun}
        value={SPEAKING_SPEED_LABELS[value]}
      />
      <HullActionSheetModal
        accessibilityLabel={`Close ${noun.toLowerCase()} picker`}
        onClose={() => setOpen(false)}
        testID="speaking-speed-sheet"
        title={noun}
        visible={open}
      >
        {SPEAKING_SPEED_OPTIONS.map((speakingSpeed) => (
          <HullActionSheetRow
            key={speakingSpeed}
            label={SPEAKING_SPEED_LABELS[speakingSpeed]}
            onPress={() => choose(speakingSpeed)}
            selected={value === speakingSpeed}
            testID={`speaking-speed-${speakingSpeed}`}
          />
        ))}
        <HullActionSheetCancel onPress={() => setOpen(false)} testID="speaking-speed-close" />
      </HullActionSheetModal>
    </>
  );
}
