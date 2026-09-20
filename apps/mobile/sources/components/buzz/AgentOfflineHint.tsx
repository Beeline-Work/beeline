import React from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';

/**
 * The pushed Room footer and its first-paint reserve are one component so the
 * handoff cannot drift when copy, wrapping, or typography changes. The hidden
 * form still participates in layout; it only withholds paint until the full
 * Room surface owns the status.
 */
export function AgentOfflineHint({ hidden = false }: { hidden?: boolean }) {
  return (
    <View
      accessibilityElementsHidden={hidden}
      importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}
      style={[styles.hint, hidden && styles.hidden]}
      testID={hidden ? 'room-open-pixel-offline-reserve' : 'agent-offline-hint'}
    >
      <Text style={styles.title}>□ AGENT OFFLINE</Text>
      <Text style={styles.text}>
        Messages stay in this Room and will be answered when the Agent is back.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  hint: {
    minWidth: 0,
    marginBottom: 7,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: theme.buzz.borderStrong,
    backgroundColor: theme.buzz.bgBase,
  },
  hidden: {
    opacity: 0,
  },
  title: {
    ...Typography.mono('semiBold'),
    ...theme.buzz.agentOfflineHintTypography.title,
    color: theme.buzz.textPrimary,
  },
  text: {
    ...Typography.default(),
    ...theme.buzz.agentOfflineHintTypography.text,
    marginTop: 3,
    color: theme.buzz.textMuted,
  },
}));
