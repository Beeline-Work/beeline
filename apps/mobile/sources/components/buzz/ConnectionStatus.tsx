import { reconnectNow, useConnectionFailure } from '@/sync/transport/live-connection';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import React from 'react';
import { SafeAreaInsetsContext, useSafeAreaInsets } from 'react-native-safe-area-context';
import { IndexRow } from './IndexRow';

/** Mounted once by the app layout. Only explicit socket request outcomes own it. */
export function ConnectionStatus({ children }: { children?: React.ReactNode }) {
  const failed = useConnectionFailure();
  const insets = useSafeAreaInsets();
  return (
    <>
      {failed && (
        <View accessibilityLiveRegion="polite" style={[styles.banner, { paddingTop: insets.top }]} testID="connection-status-disconnected">
          <IndexRow inset="flush" title="Beeline isn’t connected" description="Try your request again."
            action="Reconnect" onPress={reconnectNow} testID="connection-status-reconnect" />
        </View>
      )}
      {/* The banner has consumed the status-bar inset. Keep the provider mounted
          while toggling it so the navigator and open Room retain their state. */}
      <SafeAreaInsetsContext.Provider value={failed ? { ...insets, top: 0 } : insets}>
        {children}
      </SafeAreaInsetsContext.Provider>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  banner: { flexShrink: 0, paddingHorizontal: theme.buzz.roomList.edge, backgroundColor: theme.buzz.bgRaised },
}));
