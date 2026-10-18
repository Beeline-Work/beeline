import { registerRootComponent } from 'expo';
import React, { useState } from 'react';
import { Text, View, Pressable, StatusBar, LogBox } from 'react-native';
import { useFonts } from 'expo-font';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import Page from '../sources/app/(app)/beeline/chat/[channelId]';
import { resetProof } from './adapters/services';
import { beelineThemes } from '../sources/buzz/groknight';
import { proofTheme } from './settings';
LogBox.ignoreLogs(['[ROOM_OPEN]']);
resetProof(false);
function Proof() {
  const [visit, setVisit] = useState(0);
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
          <Pressable
            onPress={() =>
              fetch('http://10.0.2.2:8896/send', { method: 'POST' }).then(() =>
                setVisit((x) => x + 1),
              )
            }
          >
            <Text style={{ color: 'white', padding: 20 }}>Next send (covering Room read)</Text>
          </Pressable>
        </View>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
registerRootComponent(Proof);
