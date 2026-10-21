/** Disposable emulator fixture: no real account or server mutation. */
import 'react-native-get-random-values';
import '../sources/unistyles';
import React, { useState } from 'react';
import { useFonts } from 'expo-font';
import { UnistylesRuntime } from 'react-native-unistyles';
UnistylesRuntime.setTheme('obsidian');
import { registerRootComponent } from 'expo';
import { View, Text, Button } from 'react-native';
import { RunnableArtifact } from '../sources/components/buzz/RunnableArtifact';
import { monolithSession } from '../sources/auth/monolith-session';
const origin = process.env.EXPO_PUBLIC_GAME_PROOF_ORIGIN;
if (!origin)
  throw new Error('Set EXPO_PUBLIC_GAME_PROOF_ORIGIN to the disposable HTTPS fixture origin');
monolithSession.fetch = async (input) =>
  new Response(
    JSON.stringify({
      url: `${origin}/play/${String(input).match(/media\/([^/]+)/)?.[1]}?expires=9999999999&token=fixture`,
    }),
    { status: 200 },
  );
function Proof() {
  const [fontsReady] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
  });
  const [id, setId] = useState<string>();
  const [ticks, setTicks] = useState(0);
  if (!fontsReady) return null;
  return (
    <View style={{ flex: 1, paddingTop: 48, backgroundColor: '#14091a' }}>
      <Text style={{ color: 'white', fontSize: 20 }}>Beeline game sandbox · ticks {ticks}</Text>
      <Button title="Trusted counter" onPress={() => setTicks((n) => n + 1)} />
      <Button title="Close game" onPress={() => setId(undefined)} />
      {id ? (
        <RunnableArtifact
          key={id}
          attachment={{
            kind: 'artifact',
            url: `https://server.usebeeline.app/v1/media/${id}`,
            name: 'Canvas game',
            mimeType: 'application/vnd.beeline.game+html',
            size: 100,
          }}
        />
      ) : (
        <View>
          <Button
            title="Play canvas game"
            onPress={() => setId('11111111-1111-4111-8111-111111111111')}
          />
          <Button
            title="Run infinite loop"
            onPress={() => setId('22222222-2222-4222-8222-222222222222')}
          />
          <Button
            title="Test navigation"
            onPress={() => setId('33333333-3333-4333-8333-333333333333')}
          />
          <Button
            title="Test immediate navigation"
            onPress={() => setId('44444444-4444-4444-8444-444444444444')}
          />
          <Text style={{ color: 'white' }}>Game closed</Text>
        </View>
      )}
    </View>
  );
}
registerRootComponent(Proof);
