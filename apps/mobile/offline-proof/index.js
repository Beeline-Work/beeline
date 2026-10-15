import { registerRootComponent } from 'expo';
import React from 'react';
import { Text, View, StatusBar } from 'react-native';
import { useFonts } from 'expo-font';
import { groknight as t } from '../sources/buzz/groknight';
function Proof() {
 const [loaded] = useFonts({
  'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
  'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
  'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
  'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
 });
 if (!loaded) return null;
 return <View style={{flex:1, paddingTop:StatusBar.currentHeight, backgroundColor:t.bgTerminal}}>
  <View style={{padding:16,borderBottomWidth:1,borderColor:t.border}}><Text style={{...t.type.bodyStrong,color:t.textPrimary}}>#release-corner</Text></View>
  <View style={{padding:16,gap:8}}><Text style={{...t.type.meta,color:t.textMuted}}>Candy · 20:48</Text><Text style={{...t.type.body,color:t.textPrimary}}>OTA promoted to production channel.</Text></View>
 </View>;
}
registerRootComponent(Proof);
