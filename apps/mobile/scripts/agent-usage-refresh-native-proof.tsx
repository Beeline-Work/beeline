/** Native proof fixture mounts production UI and calls the isolated live helper service. */
import '../sources/unistyles';
import React, { useState } from 'react';
import { registerRootComponent } from 'expo';
import { ScrollView, Text } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { useFonts } from 'expo-font';
import { UnistylesRuntime } from 'react-native-unistyles';
import { AgentUsageSection } from '../sources/components/buzz/AgentUsageSection';
import { AgentUsageSection as Baseline } from './agent-usage-baseline';
import { PageHeader } from '../sources/components/buzz/PageHeader';
import { Button } from '../sources/components/buzz/Button';
import { InlineRow } from '../sources/components/buzz/IndexRow';
import { beelineThemes } from '../sources/buzz/groknight';
import { type AgentUsage } from '@beeline/api-contract/phone';
import initial from './agent-usage-cursor.json';
UnistylesRuntime.setTheme('obsidian');
function Proof() {
  const [loaded] = useFonts({
    'SpaceGrotesk-Regular': require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),
    'SpaceGrotesk-Medium': require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),
    'SpaceGrotesk-SemiBold': require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),
  });
  const [usage, setUsage] = useState(initial as AgentUsage);
  const [free, setFree] = useState(false);
  const [before, setBefore] = useState(false);
  const [light, setLight] = useState(false);
  const theme = light ? beelineThemes.bone : beelineThemes.obsidian;
  const Section: React.ComponentType<any> = before ? Baseline : AgentUsageSection;
  if (!loaded) return null;
  return <SafeAreaProvider><SafeAreaView style={{flex:1,backgroundColor:theme.bgBase}}>
    <ScrollView contentContainerStyle={{padding:16}}>
      <PageHeader title="Profile" />
      <Text style={{fontFamily:'SpaceGrotesk-Regular',color:theme.textPrimary}}>Nerd · Cursor · Grok 4.7 Extra High</Text>
      <Section usage={free ? {updatedAt:Date.now()/1000,windows:[],free:{used:640000,limit:3000000,resetsAt:1792708800}} : usage}
        harness={free ? 'pi' : 'cursor'} onRefresh={async () => {
          const response = await fetch('http://10.0.2.2:8140/refresh',{method:'POST'});
          if(!response.ok)throw new Error('refresh failed');
          setUsage(await response.json());
        }} />
      <InlineRow><Button label="Theme" variant="quiet" onPress={()=>{UnistylesRuntime.setTheme(light?'obsidian':'bone');setLight(!light);}} />
      <Button label={free?'Cursor':'Free'} variant="quiet" onPress={()=>setFree(!free)} />
      <Button label={before?'After':'Before'} variant="quiet" onPress={()=>setBefore(!before)} /></InlineRow>
    </ScrollView>
  </SafeAreaView></SafeAreaProvider>;
}
registerRootComponent(Proof);
