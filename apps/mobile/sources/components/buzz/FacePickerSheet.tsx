import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { defaultFaceForSeed, type FaceId } from '@/buzz/faces';
import { FaceGrid } from './FaceGrid';
import { HullActionSheetCancel, HullActionSheetModal } from './HullActionSheet';

type FacePickerSheetProps = {
  visible: boolean;
  seed: string;
  /** The face on record; absent shows the seed's default as selected. */
  face?: string | null;
  /** Optimistic: fires with the new face before the save, and again with the old one on failure. */
  onFaceChange: (face: string) => void;
  onSave: (face: FaceId) => Promise<void>;
  onClose: () => void;
};

/**
 * "Change it anytime": the ceremony grid as a settings sheet. Tapping a tile
 * saves immediately; the screen behind updates optimistically and rolls back
 * (with an inline error) when the server refuses.
 */
export function FacePickerSheet({
  visible,
  seed,
  face,
  onFaceChange,
  onSave,
  onClose,
}: FacePickerSheetProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = face ?? defaultFaceForSeed(seed);

  const choose = async (next: FaceId) => {
    if (saving || next === selected) return;
    const previous = selected;
    setSaving(true);
    setError(null);
    onFaceChange(next);
    try {
      await onSave(next);
    } catch (caught) {
      onFaceChange(previous);
      setError(
        `Could not save your face. Try again. (${caught instanceof Error ? caught.message : String(caught)})`,
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <HullActionSheetModal
      accessibilityLabel="Close face picker"
      onClose={onClose}
      scrimTestID="face-picker-scrim"
      subtitle="Animals only. You can change it anytime."
      testID="face-picker"
      title="Face"
      visible={visible}
    >
      <View style={styles.gridSlot}>
        <FaceGrid
          disabled={saving}
          onSelect={(next) => void choose(next)}
          seed={seed}
          selected={selected}
          testIDPrefix="face-picker"
        />
      </View>
      {error ? (
        <Text accessibilityRole="alert" style={styles.error} testID="face-picker-error">
          {error}
        </Text>
      ) : null}
      <HullActionSheetCancel label="Done" onPress={onClose} testID="face-picker-done" />
    </HullActionSheetModal>
  );
}

const styles = StyleSheet.create((theme) => ({
  gridSlot: { alignItems: 'center', paddingVertical: 12 },
  error: {
    ...Typography.default(),
    fontFamily: theme.buzz.proseRegular,
    color: theme.buzz.textSecondary,
    fontSize: 13,
    lineHeight: 19,
    paddingHorizontal: 22,
    paddingBottom: 8,
  },
}));
