import { reconnectNow, useConnectionState } from '@/sync/transport/live-connection';
import { Ionicons } from '@expo/vector-icons';
import { type ReactNode } from 'react';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Button } from './Button';
import { InlineRow } from './IndexRow';
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
  return <InlineRow accessibilityLiveRegion="polite" style={styles.line} testID="connection-status-disconnected">
    <Ionicons name="ban-outline" size={18} color={styles.statusGlyph.color} accessibilityRole="image"
      accessibilityLabel="Not connected" testID="connection-status-disconnected-glyph" />
    <View style={styles.copyBlock}>
      <Text style={styles.copy}>Beeline isn't connected</Text>
      <Text style={styles.saved}>Showing saved messages</Text>
    </View>
    <Button label="Reconnect" size="inline" variant="quiet" onPress={reconnectNow} testID="connection-status-reconnect" />
  </InlineRow>;
}

const styles = StyleSheet.create((theme) => ({
  line: { alignItems: 'center', gap: theme.buzz.space.sm, paddingHorizontal: theme.buzz.roomList.edge, paddingVertical: theme.buzz.space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.buzz.border, backgroundColor: theme.buzz.bgRaised },
  copyBlock: { flex: 1, minWidth: 0 },
  statusGlyph: { color: theme.buzz.ledgerQuiet },
  copy: { ...theme.buzz.type.meta, color: theme.buzz.textPrimary },
  saved: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet },
}));
