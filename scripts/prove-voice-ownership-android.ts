import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {Room,AudioSource,AudioFrame,LocalAudioTrack,TrackPublishOptions,TrackSource,dispose} from '@livekit/rtc-node';
async function main() {
const origin='http://127.0.0.1:18097';
async function get(path:string):Promise<any>{return(await fetch(origin+path)).json();}
async function post(path:string,body:unknown={},token?:string):Promise<any>{const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;}
async function until(check:(r:any)=>boolean,label:string){const start=Date.now();while(true){const result=await get('/result');if(check(result))return result;assert.ok(Date.now()-start<30000,label);await new Promise(r=>setTimeout(r,200));}}
const fixture=await get('/fixture');
const energy=(r:any,epoch:number)=>Math.max(0,...r.observations.filter((o:any)=>o.role==='listener'&&o.event==='audio'&&o.publisher.startsWith('beeline-voice-')&&o.rtcRoom.endsWith(`-e${epoch}`)).flatMap((o:any)=>o.audio.map((s:any)=>s.totalAudioEnergy??0)));
await until(r=>r.inputs.length>=2&&r.inputs.every((i:any)=>i.frames>0),'both Android microphones reach built runtime');
await post('/speak');const before=await until(r=>energy(r,1)>0.001,'listener receives native decoded agent audio before takeover');
const owner=before.owner;const at=Date.now();const replacement=await post(`/v1/phone/voice/${fixture.roomId}/takeover`,{owner},fixture.laptopToken);
const changed=await until(r=>r.observations.some((o:any)=>o.role==='phone'&&o.event==='state'&&o.joined===false&&o.error?.includes('replaced')),'replaced Android phone terminal state');
const laptop=new Room();const source=new AudioSource(16000,1,100);
try{
 await laptop.connect(replacement.url,replacement.token);const options=new TrackPublishOptions();options.source=TrackSource.SOURCE_MICROPHONE;await laptop.localParticipant!.publishTrack(LocalAudioTrack.createAudioTrack('new-owner-mic',source),options);
 for(let i=0;i<50;i++){await source.captureFrame(new AudioFrame(Int16Array.from({length:320},(_,j)=>Math.round(4000*Math.sin((i*320+j)/8))),16000,1,320));await new Promise(r=>setTimeout(r,20));}
 await until(r=>r.observations.some((o:any)=>o.role==='listener'&&o.rtcRoom?.endsWith('-e2')&&o.event==='audio'),'Android listener follows rotation');
 await post('/speak');const after=await until(r=>energy(r,2)>0.001,'listener receives decoded agent audio after rotation');
 const frozen=after.inputs.slice(0,2).map((i:any)=>i.frames);await new Promise(r=>setTimeout(r,1500));const final=await get('/result');
 assert.deepEqual(final.inputs.slice(0,2).map((i:any)=>i.frames),frozen,'old RTC room streams are closed');
 assert.equal(final.observations.some((o:any)=>o.role==='listener'&&o.rtcRoom?.endsWith('-e2')&&o.publisher?.startsWith('a'.repeat(64)+':'+owner.deviceId+':')),false,'new listener never receives replaced phone identity');
 const report={reproduction:'CALL-OWNER-1',androidDevices:[process.env.VOICE_OWNER_PHONE_LABEL??'Android phone fixture',process.env.VOICE_OWNER_LISTENER_LABEL??'Android listener fixture'],callId:replacement.call.id,takeoverRequestedAt:at,ownershipEpochBefore:owner.epoch,ownershipEpochAfter:replacement.epoch,phoneTerminalReplaced:true,listenerAudioEnergyBefore:energy(before,1),listenerAudioEnergyAfter:energy(after,2),oldRuntimeStreamsFrozen:frozen,oldPhoneAudioInNewRoom:false,observations:final.observations.filter((o:any)=>o.event==='state'||o.event==='rtc-disconnected'),standIn:'Production Android hook/native RTC, built authenticated server and LiveKit 1.9.12. Synthetic provider text/PCM, actual decoded native RTP energy; new owner is a native Node RTC client. No physical speaker measurement.'};
 await writeFile('.voice-proof/account-owner/android-result.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({...report,observations:undefined}));
}finally{await laptop.disconnect();await source.close();await dispose();}


}
void main().then(()=>process.exit(0),error=>{console.error(error);process.exit(1);});
