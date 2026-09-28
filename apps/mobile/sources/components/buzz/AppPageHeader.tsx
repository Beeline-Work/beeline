import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { ChevronGlyph } from './ChevronGlyph';
import { appBoardColors } from '@/buzz/app-board-style';

export function AppPageHeader({ eyebrow, title, onBack, backLabel, testID }: {
  eyebrow: string; title: string; onBack: () => void; backLabel: string; testID?: string;
}) {
  return <View style={styles.header} testID={testID}>
    <TouchableOpacity accessibilityRole="button" accessibilityLabel={backLabel} onPress={onBack} style={styles.back}>
      <ChevronGlyph direction="left" size={22} color={styles.title.color} />
    </TouchableOpacity>
    <View style={styles.copy}>
      <Text style={styles.eyebrow}>{eyebrow}</Text>
      <Text accessibilityRole="header" style={styles.title}>{title}</Text>
    </View>
  </View>;
}

const styles = StyleSheet.create((theme) => {
  const board = appBoardColors(theme.buzz);
  return {
  header: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingLeft: 16, paddingRight: 20, paddingTop: 18, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: board.border },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  copy: { gap: 2 },
  eyebrow: { ...Typography.ledger(), fontSize: 15, color: board.quiet },
  title: { ...Typography.ledger('medium'), fontSize: 32, lineHeight: 40, color: board.ink },
  };
});
