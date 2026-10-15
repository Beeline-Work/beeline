import { registerRootComponent } from 'expo';
import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { useFonts } from 'expo-font';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { CommunityRail } from '../sources/components/buzz/CommunityRail';
import { beelineThemes } from '../sources/buzz/groknight';
import { proofTheme } from './proof-theme';
function Proof() {
  const [result, setResult] = useState('Tap ADD');
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
    'IBMPlexMono-SemiBold': require('../sources/assets/fonts/IBMPlexMono-SemiBold.ttf'),
  });
  if (!loaded) return null;
  return (
    <SafeAreaProvider>
      <View
        style={{
          flex: 1,
          flexDirection: 'row',
          backgroundColor: beelineThemes[proofTheme].bgTerminal,
        }}
      >
        <View style={{ width: 72 }}>
          <CommunityRail
            communities={[1, 2, 3, 4].map((id) => ({
              communityId: String(id),
              name: `Workspace ${id}`,
            }))}
            activeCommunityId="2"
            onSelect={() => {}}
            onAdd={() => setResult('PASS: ADD opened')}
            onSettings={() => setResult('PASS: Settings opened')}
          />
        </View>
        <View style={{ flex: 1, paddingTop: 100, paddingLeft: 24 }}>
          <Text style={{ color: beelineThemes[proofTheme].textPrimary }}>{result}</Text>
        </View>
      </View>
    </SafeAreaProvider>
  );
}
registerRootComponent(Proof);
