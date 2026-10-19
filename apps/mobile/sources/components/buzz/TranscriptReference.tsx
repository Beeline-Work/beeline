import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

/** Shared provenance line above a reply or a message sent from a viewer. */
export function TranscriptReference({ children, viewer = false, onPress, accessibilityLabel, testID }: {
  children: React.ReactNode; viewer?: boolean; onPress?: () => void;
  accessibilityLabel?: string; testID?: string;
}) {
  const contents = viewer ? <View style={styles.viewerLine}>
    <ViewerConversationIcon />
    <Text numberOfLines={1} style={[styles.text, styles.viewerText]}>{children}</Text>
  </View> : <Text numberOfLines={2} style={styles.text}>{children}</Text>;
  return onPress ? <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel}
    onPress={onPress} style={styles.reference} testID={testID}>{contents}</Pressable>
    : <View style={styles.reference} testID={testID}>{contents}</View>;
}

/** Shared conversation icon for viewer controls and message provenance. */
export function ViewerConversationIcon() {
  return <Ionicons name="chatbubble-outline" size={20} color={styles.icon.color}
    accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />;
}

const styles = StyleSheet.create((theme) => ({
  reference: { minWidth: 0, marginBottom: theme.buzz.space.xs },
  text: { ...theme.buzz.type.machine, color: theme.buzz.ledgerQuiet },
  viewerLine: { flexDirection: 'row', alignItems: 'center', gap: theme.buzz.space.xs, minWidth: 0 },
  viewerText: { ...theme.buzz.type.meta, flexShrink: 1, minWidth: 0 },
  icon: { color: theme.buzz.accent },
}));
