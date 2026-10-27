import { registerRootComponent } from 'expo';
import React from 'react';
import { useFonts } from 'expo-font';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { MemberSheetsProof } from '../scripts/member-sheets-fixture';
function App() {
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
  });
  return loaded ? (
    <SafeAreaProvider>
      <MemberSheetsProof />
    </SafeAreaProvider>
  ) : null;
}
registerRootComponent(App);
