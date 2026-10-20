import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ConversationGlyph } from './MicGlyph';

/** Shared provenance line above a reply or a message sent from a viewer. */
export function TranscriptReference({ children, viewer = false, onPress, accessibilityLabel, testID }: {
  children: React.ReactNode; viewer?: boolean; onPress?: () => void;
  accessibilityLabel?: string; testID?: string;
}) {
  const { theme } = useUnistyles();
  const contents = viewer ? <View style={styles.viewerLine}>
    <ConversationGlyph size={14} color={theme.buzz.accent} />
    <Text numberOfLines={1} style={[styles.text, styles.viewerText]}>{children}</Text>
  </View> : <Text numberOfLines={2} style={styles.text}>{children}</Text>;
  return onPress ? <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel}
    onPress={onPress} style={styles.reference} testID={testID}>{contents}</Pressable>
    : <View style={styles.reference} testID={testID}>{contents}</View>;
}

const styles = StyleSheet.create((theme) => ({
  reference: { minWidth: 0, marginBottom: theme.buzz.space.xs },
  text: { ...theme.buzz.type.machine, color: theme.buzz.ledgerQuiet },
  viewerLine: { flexDirection: 'row', alignItems: 'center', gap: theme.buzz.space.xs, minWidth: 0 },
  viewerText: { flexShrink: 1, minWidth: 0 },
}));
