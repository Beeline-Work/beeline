import { registerRootComponent } from 'expo';
import React, { useState } from 'react';
import { Text, View, Pressable, StatusBar, LogBox } from 'react-native';
import { useFonts } from 'expo-font';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import Page from '../sources/app/(app)/beeline/chat/[channelId]';
import { failRefresh, resetProof, recoverServer } from './adapters/services';
import { beelineThemes } from '../sources/buzz/groknight';
import { proofTheme } from './settings';
LogBox.ignoreLogs(['[ROOM_OPEN]']);
resetProof();
function Proof() {
  const [visit, setVisit] = useState(0);
  const [status, setStatus] = useState('Cached page; refresh pending');
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
    'IBMPlexMono-SemiBold': require('../sources/assets/fonts/IBMPlexMono-SemiBold.ttf'),
  });
  const theme = beelineThemes[proofTheme];
  if (!loaded) return null;
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar barStyle={proofTheme === 'bone' ? 'dark-content' : 'light-content'} />
        <View style={{ flex: 1, backgroundColor: theme.bgTerminal }}>
          <View style={{ flex: 1 }}>
            <Page key={visit} />
          </View>
          <View style={{ padding: 12, gap: 8, borderTopWidth: 1, borderColor: theme.border }}>
            <Text style={{ ...theme.type.meta, color: theme.textSecondary }}>{status}</Text>
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Fail refresh"
                onPress={() => {
                  failRefresh();
                  setStatus('Refresh failed: Network request failed');
                }}
              >
                <Text style={{ color: theme.textPrimary }}>Fail refresh</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cold failed load"
                onPress={() => {
                  resetProof(false);
                  setVisit((x) => x + 1);
                  setStatus('Cold load failed');
                }}
              >
                <Text style={{ color: theme.textPrimary }}>Cold failed load</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Recover server"
                onPress={() => {
                  recoverServer();
                  setStatus('Server ready; press page Retry');
                }}
              >
                <Text style={{ color: theme.textPrimary }}>Recover server</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
registerRootComponent(Proof);
