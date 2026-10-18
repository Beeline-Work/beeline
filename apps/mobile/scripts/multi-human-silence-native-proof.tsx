/** Disposable Android entry: production hook, VoiceBar, native audio and real RTC. */
import 'react-native-get-random-values';
import React from 'react';
import { registerRootComponent } from 'expo';
import { LogBox, Text, View } from 'react-native';
import { useFonts } from 'expo-font';
import { setAppAppearance } from '../sources/unistyles';
import '../sources/unistyles';
import { useVoiceCall } from '../sources/buzz/use-voice-call';
import { VoiceCallCard } from '../sources/components/buzz/VoiceCallCard';
import { VoiceBar } from '../sources/components/buzz/VoiceBar';
import { Button } from '../sources/components/buzz/Button';
LogBox.ignoreAllLogs();
const origin='http://10.0.2.2:18097';
function Call({roomId}:{roomId:string}) {
  const voice=useVoiceCall(roomId,true);
  const [card,setCard]=React.useState<any>();
  React.useEffect(()=>{ void fetch(origin+'/result').then(r=>r.json()).then(r=>setCard(r.card?.voiceCall)); },[voice.call]);
  React.useEffect(()=>{ void fetch(origin+'/observe',{method:'POST',body:JSON.stringify({at:Date.now(),joined:!!voice.call,humans:voice.humans,error:voice.error,unaddressed:voice.unaddressed,firstAudioMs:voice.firstAudioMs})}); },[voice.call,voice.humans,voice.error,voice.unaddressed,voice.firstAudioMs]);
  return <View style={{flex:1,justifyContent:'space-between',padding:16,paddingTop:64}}>
    <Text style={{color:'#90909B'}}>Android silence proof · {voice.call?'Joined':'Left'} · humans {voice.humans}</Text>
    {card ? <VoiceCallCard call={card} joined={!!voice.call} onJoin={()=>void voice.join()}/> : <Button label="Join proof call" onPress={()=>void voice.join()}/>}
    <Button label="Bone" onPress={()=>setAppAppearance('light')}/>
    <Button label="Obsidian" onPress={()=>setAppAppearance('dark')}/>
    {voice.call && <VoiceBar voice={voice}/>}
  </View>;
}
function Proof(){
  const [fonts]=useFonts({'SpaceGrotesk-Regular':require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),'SpaceGrotesk-Medium':require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),'SpaceGrotesk-SemiBold':require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),'IBMPlexMono-Regular':require('../sources/assets/fonts/IBMPlexMono-Regular.ttf')});
  const [room,setRoom]=React.useState<string>();
  React.useEffect(()=>{ void fetch(origin+'/fixture').then(r=>r.json()).then(r=>setRoom(r.roomId)); },[]);
  return fonts&&room?<Call roomId={room}/>:null;
}
registerRootComponent(Proof);
