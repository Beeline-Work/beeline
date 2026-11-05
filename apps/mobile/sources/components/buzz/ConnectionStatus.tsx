import { reconnectNow, useConnectionState } from '@/sync/transport/live-connection';
import { type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { IndexRow, InlineRow } from './IndexRow';
import { BeelineMarkSpinner } from './BeelineMarkSpinner';

/** One socket status line shared by the Room deck and every open Room. */
type ConnectionStatusProps = {
  /** Recovery content for a failed screen read while the socket remains live. */
  connectedFallback?: ReactNode;
};

export function ConnectionStatus({ connectedFallback }: ConnectionStatusProps) {
  const state = useConnectionState();
  if (state === 'connected') return connectedFallback ?? null;
  if (state === 'connecting') {
    return <InlineRow accessibilityLiveRegion="polite" style={styles.line} testID="connection-status-connecting">
      <BeelineMarkSpinner live />
      <Text style={styles.copy}>Connecting…</Text>
    </InlineRow>;
  }
  return <View accessibilityLiveRegion="polite" style={styles.failureInset} testID="connection-status-disconnected">
    <IndexRow inset="flush" title="Beeline isn’t connected" description="Showing saved messages"
      action="Reconnect" onPress={reconnectNow} testID="connection-status-reconnect" />
  </View>;
}

const styles = StyleSheet.create((theme) => ({
  failureInset: { paddingHorizontal: theme.buzz.roomList.edge },
  line: { alignItems: 'center', gap: theme.buzz.space.sm, paddingHorizontal: theme.buzz.roomList.edge, paddingVertical: theme.buzz.space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.buzz.border, backgroundColor: theme.buzz.bgRaised },
  copy: { ...theme.buzz.type.meta, color: theme.buzz.textPrimary },
}));
