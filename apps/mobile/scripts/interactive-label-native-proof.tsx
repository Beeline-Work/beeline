/** Disposable local viewer proof: no account, production request or server mutation. */
import 'react-native-get-random-values';
import '../sources/unistyles';
import React from 'react';
import { registerRootComponent } from 'expo';
import { useFonts } from 'expo-font';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { UnistylesRuntime } from 'react-native-unistyles';
import { ArtifactViewerScreen } from '../sources/components/buzz/ArtifactViewer';
import { monolithSession } from '../sources/auth/monolith-session';

// An error state is intentional: header and recovery copy must name any kind
// of interactive page, even before the private-network fix reaches production.
monolithSession.fetch = async () => { throw new Error('Local offline proof'); };

function Proof() {
  const [fontsReady] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
  });
  if (!fontsReady) return null;
  return <SafeAreaProvider><KeyboardProvider>
    <ArtifactViewerScreen attachment={{
      kind: 'artifact',
      url: 'https://server.usebeeline.app/v1/media/a0bce317-94c6-4c0c-bf16-8d36f784c2dc',
      name: 'After midnight', title: 'After midnight',
      mimeType: 'application/vnd.beeline.game+html', size: 100,
    }} onClose={() => {}} />
  </KeyboardProvider></SafeAreaProvider>;
}
UnistylesRuntime.setTheme('obsidian');
registerRootComponent(Proof);
