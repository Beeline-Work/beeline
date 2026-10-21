import React from 'react';
import { registerRootComponent } from 'expo';
import { View } from 'react-native';
import { useFonts } from 'expo-font';
import { LedgerEntry } from '../sources/components/buzz/Ledger';
function Proof() {
 const [loaded] = useFonts({
  'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
  'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
 });
 if (!loaded) return null;
 return <View style={{flex:1,backgroundColor:'#14091A',paddingTop:120,paddingHorizontal:24}}>
 <LedgerEntry itemId="font-proof" luminous bodyText="My reply is ready. My reply stays easy to read." bodyTestID="proof" />
 </View>;
}
registerRootComponent(Proof);
