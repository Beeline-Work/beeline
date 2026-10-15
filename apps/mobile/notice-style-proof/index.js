import { registerRootComponent } from 'expo';
import React from 'react';
import { View, StatusBar } from 'react-native';
import { useFonts } from 'expo-font';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import Page from '../sources/app/(app)/beeline/chat/[channelId]';
import { beelineThemes } from '../sources/buzz/groknight';
import { proofTheme } from './settings';
function Proof() {
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
    'IBMPlexMono-SemiBold': require('../sources/assets/fonts/IBMPlexMono-SemiBold.ttf'),
  });
  if (!loaded) return null;
  return <GestureHandlerRootView style={{ flex: 1 }}><SafeAreaProvider>
    <StatusBar barStyle="dark-content" />
    <View style={{ flex: 1, backgroundColor: beelineThemes[proofTheme].bgBase }}><Page /></View>
  </SafeAreaProvider></GestureHandlerRootView>;
}
registerRootComponent(Proof);
