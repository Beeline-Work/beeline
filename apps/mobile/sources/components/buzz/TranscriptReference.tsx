import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

/** Shared provenance line above a reply or a message sent from a viewer. */
export function TranscriptReference({ children, viewer = false, onPress, accessibilityLabel, testID }: {
  children: React.ReactNode; viewer?: boolean; onPress?: () => void;
  accessibilityLabel?: string; testID?: string;
}) {
  const contents = viewer ? <View style={styles.viewerLine}>
    <ViewerConversationRing />
    <Text numberOfLines={1} style={[styles.text, styles.viewerText]}>{children}</Text>
  </View> : <Text numberOfLines={2} style={styles.text}>{children}</Text>;
  return onPress ? <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel}
    onPress={onPress} style={styles.reference} testID={testID}>{contents}</Pressable>
    : <View style={styles.reference} testID={testID}>{contents}</View>;
}

/** The same gold circle used by the floating viewer composer. */
export function ViewerConversationRing() {
  return <View style={styles.ring} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    <View style={styles.dot} />
  </View>;
}

const styles = StyleSheet.create((theme) => ({
  reference: { minWidth: 0, marginBottom: theme.buzz.space.xs },
  text: { ...theme.buzz.type.machine, color: theme.buzz.ledgerQuiet },
  viewerLine: { flexDirection: 'row', alignItems: 'center', gap: theme.buzz.space.xs, minWidth: 0 },
  viewerText: { flexShrink: 1, minWidth: 0 },
  ring: { width: 14, height: 14, borderWidth: 1, borderColor: theme.buzz.accent,
    borderRadius: 14 / 2, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 8, height: 8, borderRadius: 8 / 2, backgroundColor: theme.buzz.accent },
}));
