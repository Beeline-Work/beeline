/** Android release entry for the shared UI library fixture. */
import '../sources/unistyles';
import React from 'react';
import { registerRootComponent } from 'expo';
import { useFonts } from 'expo-font';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import SharedUiLibraryProof from './shared-ui-library-proof';

function Root() {
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexSans-Regular': require('../sources/assets/fonts/IBMPlexSans-Regular.ttf'),
    'IBMPlexSans-SemiBold': require('../sources/assets/fonts/IBMPlexSans-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  if (!loaded) return null;
  return (
    <SafeAreaProvider>
      <SharedUiLibraryProof />
    </SafeAreaProvider>
  );
}

registerRootComponent(Root);
