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
export function AgentOfflineHint({
  hidden = false,
  state = 'offline',
}: {
  hidden?: boolean;
  state?: 'offline' | 'reconnecting';
}) {
  return (
    <View
      accessibilityElementsHidden={hidden}
      importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}
      style={[styles.hint, hidden && styles.hidden]}
      testID={hidden ? 'room-open-pixel-offline-reserve' : 'agent-offline-hint'}
    >
      <View style={styles.line}>
        <View style={styles.dot} />
        <Text style={styles.title}>
          {state === 'reconnecting' ? 'CHECKING AGENT CONNECTION' : 'AGENT UNAVAILABLE'}
        </Text>
      </View>
      <Text style={styles.text}>
        {state === 'reconnecting'
          ? 'Checking whether the agent is back.'
          : 'Messages will wait here until the agent returns.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  hint: {
    minWidth: 0,
    marginBottom: 7,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: theme.buzz.textMuted,
  },
  hidden: {
    opacity: 0,
  },
  title: {
    ...Typography.mono('semiBold'),
    ...theme.buzz.agentOfflineHintTypography.title,
    color: theme.buzz.textMuted,
  },
  text: {
    ...Typography.default(),
    ...theme.buzz.agentOfflineHintTypography.text,
    marginTop: 2,
    marginLeft: 12,
    color: theme.buzz.textMuted,
  },
}));
