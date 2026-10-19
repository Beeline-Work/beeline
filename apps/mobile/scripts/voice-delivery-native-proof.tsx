/** Disposable Android entry: production hook, VoiceBar, native audio and real RTC. */
import 'react-native-get-random-values';
import '@livekit/react-native';
import React from 'react';
import { registerRootComponent } from 'expo';
import { LogBox, Text, View } from 'react-native';
import { useFonts } from 'expo-font';
import { setAppAppearance } from '../sources/unistyles';
// A bare import merges with setAppAppearance and Metro defers it until a tap.
require('../sources/unistyles');
import { useVoiceCall } from '../sources/buzz/use-voice-call';
import { VoiceCallCard } from '../sources/components/buzz/VoiceCallCard';
import { VoiceBar, VoiceAgentStrip } from '../sources/components/buzz/VoiceBar';
import { Button } from '../sources/components/buzz/Button';
LogBox.ignoreAllLogs();
import { monolithSession } from '../sources/auth/monolith-session';
monolithSession.fetch = (input, init = {}, options = {}) => (options.fetchImpl ?? fetch)(input, init);
// Observe actual inbound RTP on the native client, without changing the transport.
import { Room, RoomEvent } from 'livekit-client';
const emit = Room.prototype.emit;
(Room.prototype as any).emit = function (event: string, ...args: any[]) {
  const track = args[0];
  if (event === RoomEvent.TrackSubscribed && track.kind === 'audio') {
    const timer = setInterval(() => {
      void track.getRTCStatsReport().then((stats: any) => {
        const audio: unknown[] = [];
        stats?.forEach((row: any) => { if (row.type === 'inbound-rtp') audio.push({ bytesReceived: row.bytesReceived, packetsReceived: row.packetsReceived, totalAudioEnergy: row.totalAudioEnergy }); });
        return fetch('http://10.0.2.2:18097/observe', { method: 'POST', body: JSON.stringify({ at: Date.now(), nativeAudio: audio }) });
      }).catch(() => {});
    }, 500);
    this.once(RoomEvent.Disconnected, () => clearInterval(timer));
  }
  return emit.apply(this, [event, ...args] as any);
};

const origin='http://10.0.2.2:18097';
function Call({roomId}:{roomId:string}) {
  const voice=useVoiceCall(roomId,true);
  const [card,setCard]=React.useState<any>();
  const [requests,setRequests]=React.useState<string[]>([]);
  React.useEffect(()=>{ void fetch(origin+'/result').then(r=>r.json()).then(r=>setRequests(
    r.transcript.filter((row:any)=>row.author==='a'.repeat(64)&&row.text.includes('build')).map((row:any)=>row.text)));
  },[voice.firstAudioMs]);
  React.useEffect(()=>{ void fetch(origin+'/result').then(r=>r.json()).then(r=>setCard(r.card?.voiceCall)); },[voice.call,voice.humans]);
  React.useEffect(()=>{ void fetch(origin+'/observe',{method:'POST',body:JSON.stringify({at:Date.now(),joined:!!voice.call,humans:voice.humans,error:voice.error,unaddressed:voice.unaddressed,firstAudioMs:voice.firstAudioMs})}); },[voice.call,voice.humans,voice.error,voice.unaddressed,voice.firstAudioMs]);
  return <View style={{flex:1,justifyContent:'space-between',padding:16,paddingTop:64}}>
    <Text style={{color:'#90909B'}}>Android request delivery proof · {voice.call?'Joined':'Left'} · humans {voice.humans}</Text>
    {card ? <VoiceCallCard call={card} joined={!!voice.call} onJoin={()=>void voice.join()}/> : <Button label="Join proof call" onPress={()=>void voice.join()}/>}
    <View pointerEvents="none" style={{position:'absolute',top:280,left:16,right:16}}>{requests.map((text,index)=><Text key={index} style={{color:'#90909B',fontSize:16}}>{text}</Text>)}</View>
    <Button label="Bone" onPress={()=>setAppAppearance('light')}/>
    <Button label="Obsidian" onPress={()=>setAppAppearance('dark')}/>
    {voice.call && <View><VoiceAgentStrip voice={voice}/><VoiceBar voice={voice}/></View>}
  </View>;
}
function Proof(){
  const [fonts]=useFonts({'SpaceGrotesk-Regular':require('../sources/assets/fonts/SpaceGrotesk-Regular.ttf'),'SpaceGrotesk-Medium':require('../sources/assets/fonts/SpaceGrotesk-Medium.ttf'),'SpaceGrotesk-SemiBold':require('../sources/assets/fonts/SpaceGrotesk-SemiBold.ttf'),'IBMPlexMono-Regular':require('../sources/assets/fonts/IBMPlexMono-Regular.ttf')});
  const [room,setRoom]=React.useState<string>();
  React.useEffect(()=>{ void fetch(origin+'/fixture').then(r=>r.json()).then(r=>setRoom(r.roomId)); },[]);
  return fonts&&room?<Call roomId={room}/>:null;
}
registerRootComponent(Proof);
