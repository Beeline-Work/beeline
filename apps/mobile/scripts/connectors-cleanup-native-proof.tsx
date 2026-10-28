/** CONNECTORS-1: production native rows with the built local PhoneService's owner-shaped answer. */
import 'react-native-get-random-values';
import React from 'react';
import { registerRootComponent } from 'expo';
import { ScrollView, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { useFonts } from 'expo-font';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { setAppAppearance } from '../sources/unistyles';
require('../sources/unistyles');
import { AiClientsSection } from '../sources/components/buzz/AiClientsSection';
import { PageHeader } from '../sources/components/buzz/PageHeader';
import { RoomListSectionHeader } from '../sources/components/buzz/RoomListSectionHeader';
import { SettingsRow } from '../sources/components/buzz/SettingsRow';
import { ServiceMark } from '../sources/components/buzz/ServiceMark';
import { Button } from '../sources/components/buzz/Button';
import { monolithSession } from '../sources/auth/monolith-session';
import type { WorkbenchView } from '@beeline/api-contract/workbench';
const origin='http://10.0.2.2:18167';
monolithSession.fetch=(input,init={})=>fetch(origin,{method:'POST',body:JSON.stringify({operation:'disconnectAiClient',input:JSON.parse(String(init.body))})});
function Proof(){
  const {theme}=useUnistyles();
  const [view,setView]=React.useState<WorkbenchView>();
  const [loaded]=useFonts({'SpaceGrotesk-Regular':require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),'SpaceGrotesk-Medium':require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),'SpaceGrotesk-SemiBold':require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),'IBMPlexMono-Regular':require('../sources/assets/fonts/IBMPlexMono-Regular.ttf')});
  const refresh=async()=>{setView(await fetch(origin).then(r=>r.json()));};
  React.useEffect(()=>{void refresh();},[]);
  if(!loaded)return null;
  return <GestureHandlerRootView style={styles.fill}><SafeAreaProvider><KeyboardProvider>
    <View style={[styles.fill,{backgroundColor:theme.buzz.appCanvas,paddingTop:theme.buzz.space.xxl}]}>
      <PageHeader prominent eyebrow="Settings" title="Connectors"/>
      <ScrollView contentContainerStyle={styles.content}>
        {(['attention','apps'] as const).map(section=><View key={section}>
          <RoomListSectionHeader title={section==='attention'?'Needs attention':'Connected apps'} inset="content" spacing="flush"/>
          {view?.companies?.rows.filter(row=>row.section===section).map(row=>row.roomsClientId
            ? <AiClientsSection key={row.id} clients={(view.aiClients??[]).filter(c=>c.clientId===row.roomsClientId)} onChanged={refresh}/>
            : <SettingsRow key={row.id} appBoard title={row.name} description={row.subtitle} action="Reconnect" leading={<ServiceMark company={row.name} mark={row.logo}/>}/>)}</View>)}
        <Button label="Bone" onPress={()=>setAppAppearance('light')}/><Button label="Obsidian" onPress={()=>setAppAppearance('dark')}/>
      </ScrollView>
    </View>
  </KeyboardProvider></SafeAreaProvider></GestureHandlerRootView>;
}
const styles=StyleSheet.create(theme=>({fill:{flex:1},content:{padding:theme.buzz.space.lg,gap:theme.buzz.layout.sectionGap}}));
registerRootComponent(Proof);
