import 'react-native-get-random-values';
import './setup';
import React from 'react';
import { registerRootComponent } from 'expo';
import { useFonts } from 'expo-font';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import ConnectScreen from '../../sources/app/(app)/beeline/settings/workbench/connect';
import { Button } from '../../sources/components/buzz/Button';
import { boneTheme } from '../../sources/theme';
import { ProofState } from './state';

function Proof() {
  const [failed, setFailed] = React.useState(false);
  const [audit, setAudit] = React.useState(false);
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
  });
  if (!loaded) return null;
  return <SafeAreaProvider><View style={{ flex: 1 }}>
    {audit ? <View style={{ flex: 1, padding: 24, paddingTop: 100, gap: 24, backgroundColor: boneTheme.buzz.appCanvas }}>
      <Text>Shared Button disabled audit · Bone</Text>
      <Button label="Primary disabled" disabled />
      <Button label="Continue with Google" variant="provider" disabled />
      <Button label="Continue with Google" variant="provider" />
    </View> : <ProofState.Provider value={failed}><ConnectScreen key={String(failed)} /></ProofState.Provider>}
    <Pressable onPress={() => setFailed(!failed)} onLongPress={() => setAudit(!audit)} style={{ padding: 16, backgroundColor: '#F3EEE4' }}>
      <Text>Local fixture · show {failed ? 'locked' : 'Try again'}</Text>
    </Pressable>
  </View></SafeAreaProvider>;
}
registerRootComponent(Proof);
