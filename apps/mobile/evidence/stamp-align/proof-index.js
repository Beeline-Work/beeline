import { registerRootComponent } from 'expo';
import React from 'react';
import { View, StatusBar, Text } from 'react-native';
import { useFonts } from 'expo-font';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { LedgerRoomUpdate, LedgerSystemLine } from '../sources/components/buzz/Ledger';
import { beelineThemes } from '../sources/buzz/groknight';
import { proofTheme } from './settings';
const build = process.env.EXPO_PUBLIC_STAMP_BUILD ?? 'pr';
function Proof() {
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
    'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
    'IBMPlexMono-SemiBold': require('../sources/assets/fonts/IBMPlexMono-SemiBold.ttf'),
  });
  if (!loaded) return null;
  const theme = beelineThemes[proofTheme];
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <View style={{ flex: 1, backgroundColor: theme.bgBase, paddingTop: 64, paddingHorizontal: 16 }}>
        <Text style={{ color: theme.ledgerQuiet, marginBottom: 24 }}>{`build: ${build}`}</Text>
        <LedgerSystemLine id="one" text="The request to edit a key was allowed" stamp="11:00" />
        <LedgerSystemLine
          id="two"
          text="The request to edit a key was allowed for Ruby in the release corner after passkey approval"
          stamp="11:02"
        />
        <LedgerSystemLine
          id="clamped"
          text={'Scheduler ran a schedule for Ruby · Execute directly in the corner under its current brief. '.repeat(4)}
          stamp="11:04"
        />
        <LedgerRoomUpdate id="joined" line="Ruby joined the room" stamp="11:06" />
        <LedgerRoomUpdate
          id="digest"
          line="Corner stamp-align opened"
          digest="Align the timestamp with the text on system lines and room-update lines."
          stamp="11:08"
        />
      </View>
    </SafeAreaProvider>
  );
}
registerRootComponent(Proof);
