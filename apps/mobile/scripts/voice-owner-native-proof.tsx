/** Disposable CALL-OWNER-1 native fixture; production hook and native transport. */
import 'react-native-get-random-values';
import '@livekit/react-native';
import '../sources/unistyles';
import React from 'react';
import {registerRootComponent} from 'expo';
import {View,Text,Linking,LogBox} from 'react-native';
import {Room,RoomEvent} from 'livekit-client';
import {monolithSession} from '../sources/auth/monolith-session';
import {useVoiceCall} from '../sources/buzz/use-voice-call';
LogBox.ignoreAllLogs();
const origin='http://10.0.2.2:18097';
let access='',role='phone';
const observe=(data:any)=>fetch(origin+'/observe',{method:'POST',body:JSON.stringify({role,at:Date.now(),...data})}).catch(()=>{});
monolithSession.fetch=async(input,init={},options={})=>{
 const response=await(options.fetchImpl??fetch)(input,{...init,headers:{...init.headers,authorization:`Bearer ${access}`}});
 if(String(input).endsWith('/join')&&response.ok){const value=await response.json();value.url=value.url.replace('127.0.0.1','10.0.2.2');return {ok:true,status:200,json:async()=>value} as Response;}
 return response;
};
const emit=Room.prototype.emit;
(Room.prototype as any).emit=function(event:string,...args:any[]){
 if(event===RoomEvent.Disconnected)void observe({event:'rtc-disconnected',rtcRoom:this.name});
 if(event===RoomEvent.TrackSubscribed&&args[0].kind==='audio'){
  const track=args[0],rtcRoom=this.name,publisher=args[2]?.identity;
  const timer=setInterval(()=>{void track.getRTCStatsReport().then((stats:any)=>{const audio:any[]=[];stats?.forEach((r:any)=>{if(r.type==='inbound-rtp')audio.push({bytesReceived:r.bytesReceived,packetsReceived:r.packetsReceived,totalAudioEnergy:r.totalAudioEnergy})});return observe({event:'audio',rtcRoom,publisher,audio});}).catch(()=>{});},250);
  this.once(RoomEvent.Disconnected,()=>clearInterval(timer));
 }
 return emit.apply(this,[event,...args]as any);
};
function Call({roomId}:{roomId:string}){const voice=useVoiceCall(roomId,true);React.useEffect(()=>{void voice.join()},[]);React.useEffect(()=>{void observe({event:'state',joined:!!voice.call,error:voice.error,callId:voice.call?.id});},[voice.call,voice.error]);return <View style={{flex:1,backgroundColor:'#161616',padding:30,paddingTop:100}}><Text style={{color:'white',fontSize:24}}>Ownership proof: {role}</Text><Text style={{color:'white'}}>Call {voice.call?'joined':'left'}</Text><Text style={{color:'white'}}>{voice.error??''}</Text></View>}
function App(){const [room,setRoom]=React.useState<string>();React.useEffect(()=>{void(async()=>{const link=await Linking.getInitialURL();role=link?.includes('listener')?'listener':'phone';const f=await(await fetch(origin+'/fixture')).json();access=role==='listener'?f.listenerToken:f.phoneToken;setRoom(f.roomId);})();},[]);return room?<Call roomId={room}/>:null;}
registerRootComponent(App);
