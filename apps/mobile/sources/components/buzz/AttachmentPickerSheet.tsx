import React from 'react';
import { Modal, Pressable, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { HullSurface } from './MonoHull';

type AttachmentPickerSheetProps = {
  visible: boolean;
  onClose: () => void;
  onPickDocument: () => void;
  onPickPhoto: () => void;
};

/** A deliberate attachment choice, presented in the same hull as Room actions. */
export function AttachmentPickerSheet({
  visible,
  onClose,
  onPickDocument,
  onPickPhoto,
}: AttachmentPickerSheetProps) {
  const insets = useSafeAreaInsets();
  const choose = (action: () => void) => {
    onClose();
    action();
  };

  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={visible}>
      <View style={[styles.root, { paddingBottom: Math.max(insets.bottom, 18) }]}>
        <Pressable
          accessibilityLabel="Close attachment picker"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
          testID="attachment-picker-scrim"
        />
        <HullSurface strength="raised" style={styles.sheet} testID="attachment-picker-sheet">
          <View style={styles.heading}>
            <View style={styles.headingCopy}>
              <Text style={styles.eyebrow}>ATTACH</Text>
              <Text style={styles.title}>Add to this message</Text>
            </View>
            <TouchableOpacity
              accessibilityLabel="Close attachment picker"
              accessibilityRole="button"
              onPress={onClose}
              style={styles.close}
              testID="attachment-picker-close"
            >
              <Text style={styles.closeText}>×</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.options}>
            <AttachmentOption
              description="Choose an image from your library"
              glyph="▧"
              label="PHOTO"
              onPress={() => choose(onPickPhoto)}
              testID="attachment-picker-photo"
            />
            <AttachmentOption
              description="Choose a file from this device"
              glyph="≡"
              label="DOCUMENT"
              onPress={() => choose(onPickDocument)}
              testID="attachment-picker-document"
            />
          </View>
        </HullSurface>
      </View>
    </Modal>
  );
}

function AttachmentOption({
  description,
  glyph,
  label,
  onPress,
  testID,
}: {
  description: string;
  glyph: string;
  label: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <TouchableOpacity
      accessibilityLabel={`${label.toLowerCase()}. ${description}`}
      accessibilityRole="button"
      onPress={onPress}
      style={styles.option}
      testID={testID}
    >
      <View style={styles.optionGlyphFrame}>
        <Text style={styles.optionGlyph}>{glyph}</Text>
      </View>
      <View style={styles.optionCopy}>
        <Text style={styles.optionLabel}>{label}</Text>
        <Text style={styles.optionDescription}>{description}</Text>
      </View>
      <Text style={styles.optionArrow}>›</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create((theme) => {
  const groknight = theme.buzz;
  return {
    root: {
      flex: 1,
      paddingHorizontal: 16,
      alignItems: 'center',
      justifyContent: 'flex-end',
      backgroundColor: 'rgba(5, 5, 6, 0.84)',
    },
    sheet: {
      width: '100%',
      maxWidth: 460,
      padding: 16,
      borderWidth: 1,
      borderColor: groknight.borderStrong,
      backgroundColor: groknight.bgRaised,
    },
    heading: { minWidth: 0, flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
    headingCopy: { flex: 1, minWidth: 0 },
    eyebrow: {
      ...Typography.mono('semiBold'),
      color: groknight.textMuted,
      fontSize: 9,
      lineHeight: 12,
      letterSpacing: 0.8,
    },
    title: {
      ...Typography.default('semiBold'),
      marginTop: 4,
      color: groknight.textPrimary,
      fontSize: 19,
      lineHeight: 24,
    },
    close: {
      width: 44,
      height: 44,
      marginTop: -10,
      marginRight: -10,
      alignItems: 'center',
      justifyContent: 'center',
    },
    closeText: { ...Typography.default(), color: groknight.steel, fontSize: 24 },
    options: { marginTop: 18, gap: 8 },
    option: {
      minHeight: 68,
      paddingHorizontal: 12,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      borderWidth: 1,
      borderColor: groknight.borderStrong,
      backgroundColor: groknight.bgBase,
    },
    optionGlyphFrame: {
      width: 38,
      height: 38,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: groknight.border,
      backgroundColor: groknight.bgHighlight,
    },
    optionGlyph: {
      ...Typography.mono(),
      color: groknight.accent,
      fontSize: 18,
      lineHeight: 22,
    },
    optionCopy: { flex: 1, minWidth: 0 },
    optionLabel: {
      ...Typography.mono('semiBold'),
      color: groknight.textPrimary,
      fontSize: 10,
      lineHeight: 14,
      letterSpacing: 0.6,
    },
    optionDescription: {
      ...Typography.default(),
      marginTop: 3,
      color: groknight.textMuted,
      fontSize: 11,
      lineHeight: 15,
    },
    optionArrow: {
      ...Typography.default(),
      color: groknight.steel,
      fontSize: 20,
      lineHeight: 24,
    },
  };
});
