import { reconnectNow, useConnectionState } from '@/sync/transport/live-connection';
import { Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Button } from './Button';
import { PixelLoader } from './MonoHull';

/** One socket status line shared by the Room deck and every open Room. */
export function ConnectionStatus() {
  const state = useConnectionState();
  if (state === 'connected') return null;
  if (state === 'connecting') {
    return <View accessibilityLiveRegion="polite" style={styles.line} testID="connection-status-connecting">
      <PixelLoader compact />
      <Text style={styles.copy}>Connecting…</Text>
    </View>;
  }
  return <View accessibilityLiveRegion="polite" style={styles.line} testID="connection-status-disconnected">
    <View style={styles.copyBlock}>
      <Text style={styles.copy}>Beeline isn't connected</Text>
      <Text style={styles.saved}>Showing saved messages</Text>
    </View>
    <Button label="Reconnect" size="inline" variant="quiet" onPress={reconnectNow} testID="connection-status-reconnect" />
  </View>;
}

const styles = StyleSheet.create((theme) => ({
  line: { flexDirection: 'row', alignItems: 'center', gap: theme.buzz.space.sm, paddingHorizontal: theme.buzz.roomList.edge, paddingVertical: theme.buzz.space.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.buzz.border, backgroundColor: theme.buzz.bgRaised },
  copyBlock: { flex: 1, minWidth: 0 },
  copy: { ...theme.buzz.type.meta, color: theme.buzz.textPrimary },
  saved: { ...theme.buzz.type.meta, color: theme.buzz.ledgerQuiet },
}));
