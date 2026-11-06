import { reconnectNow, useConnectionFailure } from '@/sync/transport/live-connection';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IndexRow } from './IndexRow';

/** Mounted once by the app layout. Only explicit socket request outcomes own it. */
export function ConnectionStatus() {
  const failed = useConnectionFailure();
  const insets = useSafeAreaInsets();
  if (!failed) return null;
  return <View accessibilityLiveRegion="polite" style={[styles.banner, { paddingTop: insets.top }]} testID="connection-status-disconnected">
    <IndexRow inset="flush" title="Beeline isn’t connected" description="Try your request again."
      action="Reconnect" onPress={reconnectNow} testID="connection-status-reconnect" />
  </View>;
}

const styles = StyleSheet.create((theme) => ({
  banner: { paddingHorizontal: theme.buzz.roomList.edge, backgroundColor: theme.buzz.bgRaised },
}));
