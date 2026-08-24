import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

type SettingsNavigationRowProps = {
  glyph: string;
  label: string;
  supportingCopy: string;
  onPress: () => void;
  testID?: string;
};

/** A settings destination is an index row, never a primary commit plate. */
export function SettingsNavigationRow({
  glyph,
  label,
  supportingCopy,
  onPress,
  testID,
}: SettingsNavigationRowProps) {
  return (
    <TouchableOpacity
      accessibilityLabel={`${label}. ${supportingCopy}`}
      accessibilityRole="button"
      onPress={onPress}
      style={styles.row}
      testID={testID}
    >
      <Text accessibilityElementsHidden style={styles.glyph}>
        {glyph}
      </Text>
      <View style={styles.copy}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.supportingCopy}>{supportingCopy}</Text>
      </View>
      <Text accessibilityElementsHidden style={styles.chevron}>
        ›
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    minHeight: 68,
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.buzz.border,
  },
  glyph: {
    ...Typography.mono('semiBold'),
    width: 30,
    flexShrink: 0,
    color: theme.buzz.chrome,
    fontSize: 16,
    lineHeight: 22,
    textAlign: 'center',
  },
  copy: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 10,
    paddingVertical: 11,
  },
  label: {
    ...Typography.default('semiBold'),
    fontFamily: theme.buzz.proseSemibold,
    color: theme.buzz.textPrimary,
    fontSize: 14,
    lineHeight: 19,
  },
  supportingCopy: {
    ...Typography.default(),
    fontFamily: theme.buzz.proseRegular,
    marginTop: 3,
    color: theme.buzz.textMuted,
    fontSize: 11,
    lineHeight: 16,
  },
  chevron: {
    ...Typography.default(),
    width: 44,
    color: theme.buzz.chrome,
    fontSize: 22,
    lineHeight: 26,
    textAlign: 'center',
  },
}));
