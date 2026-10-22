import { registerRootComponent } from 'expo';
import React from 'react';
import { View, Text, StatusBar } from 'react-native';
import { useFonts } from 'expo-font';
import { TurnProgressLine, TurnBandSlot } from '../sources/components/buzz/TurnProgressLine';
import { beelineThemes } from '../sources/buzz/groknight';
import { proofTheme } from './proof-theme';
function Proof() {
 const t = beelineThemes[proofTheme];
 const [loaded] = useFonts({
 'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
 'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
 'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
 'IBMPlexMono-Regular': require('../sources/assets/fonts/IBMPlexMono-Regular.ttf'),
 'IBMPlexMono-SemiBold': require('../sources/assets/fonts/IBMPlexMono-SemiBold.ttf'),
 });
 if (!loaded) return null;
 return <View style={{flex:1,backgroundColor:t.bgTerminal,paddingTop:56,paddingBottom:32}}>
 <StatusBar barStyle={proofTheme === 'bone' ? 'dark-content' : 'light-content'}/>
 <Text style={{...t.type.body,color:t.textPrimary,padding:16}}>#beeline</Text>
 <Text style={{...t.type.meta,color:t.textSecondary,padding:16}}>R1 · Android · {proofTheme} · production turn-line component</Text>
 <View style={{flex:1,justifyContent:'flex-end',padding:16,paddingBottom:54}}>
 <Text style={{...t.type.body,color:t.textPrimary}}>The agent is answering this Room’s question.</Text>
 </View>
 <View style={{position:'relative',backgroundColor:t.bgTerminal}}>
 <TurnBandSlot><TurnProgressLine label="Emberus Working…" startedAt={Math.floor(Date.now()/1000)-396} onStop={()=>{}} testID="turn-progress-line" /></TurnBandSlot>
 <View style={{marginHorizontal:16,padding:16,borderWidth:1,borderColor:t.border,borderRadius:14,backgroundColor:t.bgRaised}}><Text style={{...t.type.body,color:t.textMuted}}>＋  Tag an agent with @</Text></View>
 </View></View>;
}
registerRootComponent(Proof);
