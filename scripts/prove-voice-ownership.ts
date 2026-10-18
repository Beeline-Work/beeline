/** CALL-OWNER-1: disposable built-server HTTP + real LiveKit proof; no production data. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Room,RoomEvent,AudioSource,AudioFrame,AudioStream,LocalAudioTrack,TrackPublishOptions,TrackSource,TrackKind,dispose } from '@livekit/rtc-node';
import { PgliteDatabase } from '../apps/server/src/test-support.js';
import { readVoiceJoin, type VoiceJoin, type VoiceOwner } from '@beeline/api-contract/phone';
async function main() {
// Load compiled server code at runtime while checking its interface from source.
const builtServerModule = (name: string) => pathToFileURL(resolve(`apps/server/dist/${name}.js`)).href;
const { PostgresDatabase, migrate } = await import(builtServerModule('database')) as typeof import('../apps/server/src/database.js');
const { TokenAuth } = await import(builtServerModule('auth')) as typeof import('../apps/server/src/auth.js');
const { PhoneService } = await import(builtServerModule('phone-service')) as typeof import('../apps/server/src/phone-service.js');
const { DaemonService } = await import(builtServerModule('daemon-service')) as typeof import('../apps/server/src/daemon-service.js');
const { LiveHub } = await import(builtServerModule('live')) as typeof import('../apps/server/src/live.js');
const { VoiceService } = await import(builtServerModule('voice-service')) as typeof import('../apps/server/src/voice-service.js');
const { createBeelineServer } = await import(builtServerModule('server')) as typeof import('../apps/server/src/server.js');

const H='a'.repeat(64), S='d'.repeat(64), A='b'.repeat(64), W=randomUUID(), R=randomUUID(), DM=randomUUID();
const baseline=process.env.VOICE_OWNER_BASELINE_MODULE;
const Service:typeof VoiceService=baseline?(await import(pathToFileURL(baseline).href)).VoiceService:VoiceService;
const postgres = process.env.VOICE_OWNER_TEST_POSTGRES_URL;
if (postgres) { const target=new URL(postgres); assert.ok(['127.0.0.1','localhost'].includes(target.hostname) && target.pathname==='/ownerproof','disposable loopback ownerproof database only'); }
const db=postgres?new PostgresDatabase(postgres,5,{mode:'migration'}):new PgliteDatabase(),live=new LiveHub();
const inputs:{frames:number}[]=[];
const service=new Service(db,live,{url:baseline?'ws://127.0.0.1:18000':'ws://127.0.0.1:17980',apiKey:'devkey',apiSecret:'secret',
 brain:{async answer(){return {text:'Ready.',order:false};}},
 speech:{async *synthesize(){const pcm=new Int16Array(24000);for(let i=0;i<pcm.length;i++)pcm[i]=Math.round(4000*Math.sin(i/8));yield new Uint8Array(pcm.buffer);}},
 stt:async()=>{const input={frames:0};inputs.push(input);return{send(){input.frames++;},close(){}};}});
const auth=new TokenAuth(db,async token=>({subject:token,login:token,name:token}));
await migrate(db);
await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Alex','alex'),($2,'human','Sam','sam'),($3,'agent','Ruby','ruby')`,[H,S,A]);
await db.query(`INSERT INTO agents(agent_id,owner_id,soul) VALUES($1,$2,'{}')`,[A,H]);
await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Ownership proof')`,[W]);
await db.query(`INSERT INTO rooms(id,workspace_id,name,direct_participants) VALUES($1,$3,'Room',NULL),($2,$3,'DM',$4::jsonb)`,[R,DM,W,JSON.stringify({[H]:true,[A]:true})]);
for(const who of [H,S,A]){await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member'),($1,$4,$2,'member')`,[W,who,R,DM]);}
for(const [subject,id] of [['phone',H],['laptop',H],['listener',S]])await db.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login) VALUES('github',$1,$2,'https://github.com','beeline',$1)`,[subject,id]);
const phone=await auth.exchangeGitHubOidc('phone'),laptop=await auth.exchangeGitHubOidc('laptop'),listener=await auth.exchangeGitHubOidc('listener');
const server=createBeelineServer({database:db,auth,phone:new PhoneService(db,'http://proof'),daemon:new DaemonService(db,live),live,voice:service,mediaMaximumBytes:1024});
const clients:Room[]=[],sources:AudioSource[]=[];const observed=new Map<string,number>();const first=new Map<string,number>();
const observations:unknown[]=[];
const original=server.listeners('request')[0] as (req:any,res:any)=>void;server.removeAllListeners('request');
server.on('request',(req,res)=>{if(!['/fixture','/observe','/result','/speak'].includes(req.url??'')){original(req,res);return;}void(async()=>{
 let value:unknown={};if(req.url==='/fixture')value={roomId:R,workspaceId:W,humanId:H,phoneToken:phone.accessToken,listenerToken:listener.accessToken,laptopToken:laptop.accessToken};
 if(req.url==='/observe'){let body='';for await(const c of req)body+=c;observations.push(JSON.parse(body));}
 if(req.url==='/result')value={observations,inputs,owner:(await db.query<any>('SELECT call_id AS \"callId\",device_id AS \"deviceId\",session_id AS \"sessionId\",epoch FROM voice_account_owners WHERE identity_id=$1',[H])).rows[0],call:await service.current(R,H),card:(await new PhoneService(db,'http://proof').readRoom(R,H))?.messages.find(m=>m.voiceCall)};
 if(req.url==='/speak'){const call=await service.current(R,H);assert.ok(call);const row=(await db.query<any>('SELECT * FROM voice_calls WHERE id=$1',[call.id])).rows[0];await(await service.ensureRuntime(row))!.utterance(S,'Ruby ready?');}
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));})().catch(e=>{res.statusCode=500;res.end(JSON.stringify({error:String(e)}));});});
await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(18097,'127.0.0.1',resolve);});
const origin='http://127.0.0.1:18097';
async function request(room:string,action:string,credential=phone.accessToken,body:unknown={}){const response=await fetch(`${origin}/v1/phone/voice/${room}/${action}`,{method:'POST',headers:{authorization:`Bearer ${credential}`,'content-type':'application/json'},body:JSON.stringify(body)});const value:any=await response.json();return{status:response.status,value};}
async function join(room=R,credential=phone.accessToken,body:unknown={}):Promise<VoiceJoin>{const r=await request(room,'join',credential,body);assert.equal(r.status,200,JSON.stringify(r.value));const parsed=readVoiceJoin(r.value);assert.ok(parsed,'validated join receipt');return parsed;}
async function connect(joined:VoiceJoin){const r=new Room();clients.push(r);r.on(RoomEvent.TrackSubscribed,(track,_p,participant)=>{if(track.kind!==TrackKind.KIND_AUDIO)return;void(async()=>{const reader=new AudioStream(track,16000,1).getReader();try{while(true){const f=await reader.read();if(f.done)return;if(f.value.data.some(v=>Math.abs(v)>100)){observed.set(participant.identity,(observed.get(participant.identity)??0)+1);if(!first.has(participant.identity))first.set(participant.identity,performance.now());}}}catch{}finally{reader.releaseLock();}})();});await r.connect(joined.url,joined.token);return r;}
async function audio(room:Room,ms=500){const s=new AudioSource(16000,1,100);sources.push(s);const o=new TrackPublishOptions();o.source=TrackSource.SOURCE_MICROPHONE;await room.localParticipant!.publishTrack(LocalAudioTrack.createAudioTrack('proof-tone',s),o);for(let i=0;i<ms/20;i++){await s.captureFrame(new AudioFrame(Int16Array.from({length:320},(_,j)=>Math.round(8000*Math.sin(2*Math.PI*440*(i*320+j)/16000))),16000,1,320));await new Promise(r=>setTimeout(r,20));}}
function owner(joined:VoiceJoin):VoiceOwner{return{callId:joined.call.id,deviceId:joined.deviceId!,epoch:joined.epoch!,sessionId:joined.sessionId};}
async function leave(joined:VoiceJoin,credential=phone.accessToken){await request(joined.call.id,'leave',credential,{sessionId:joined.sessionId,epoch:joined.epoch});}
async function close(){await Promise.allSettled(clients.map(r=>r.disconnect()));await Promise.allSettled(sources.map(s=>s.close()));await service.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await db.close();await Promise.race([dispose(),new Promise(r=>setTimeout(r,2000))]);}
try{
 if(process.env.VOICE_OWNER_ANDROID==='1'){
  console.log('CALL-OWNER-1 built server ready on 18097');
  process.on('SIGTERM',()=>void close().then(()=>process.exit()));process.on('SIGINT',()=>void close().then(()=>process.exit()));
  await new Promise(()=>{});
 }else{
  const latencies:number[]=[];
  for(let i=0;i<Number(process.env.VOICE_OWNER_SAMPLES??5);i++){
   const other=await join(R,listener.accessToken);const receiver=await connect(other);
   const start=performance.now();const joined=await join();const sender=await connect(joined);const identity=JSON.parse(Buffer.from(joined.token.split('.')[1]!,'base64url').toString()).sub;first.delete(identity);
   await audio(sender);assert.ok(first.has(identity),'real listener receives mic audio');latencies.push(first.get(identity)!-start);
   assert.ok(inputs.some(i=>i.frames>0),'voice runtime receives microphone');
   await sender.disconnect();await receiver.disconnect();await leave(joined);await leave(other,listener.accessToken);
  }
  const result:any={reproduction:'CALL-OWNER-1',baseline:!!baseline,latenciesMs:latencies};
  if(process.env.VOICE_OWNER_LATENCY_ONLY!=='1'){
  const dm=await join(DM);const dmClient=await connect(dm);await audio(dmClient);await dmClient.disconnect();await leave(dm);
  result.newRoomAndDmAndRuntime=true;
  if(baseline){
   const other=await join(R,listener.accessToken);const receiver=await connect(other);
   const original=await join();const old=await connect(original);await audio(old);const cached=old.token!;
   const second=await join(R,laptop.accessToken);const newDevice=await connect(second);
   const id=JSON.parse(Buffer.from(original.token.split('.')[1]!, 'base64url').toString()).sub;
   const before=observed.get(id)??0;const replay=await connect({...original,token:cached});await audio(replay);
   const staleFrames=(observed.get(id)??0)-before;assert.ok(staleFrames>0,'baseline reproduces cached stale audio');
   Object.assign(result,{ordinarySecondJoinStatus:200,ordinarySecondJoinReplacedSession:second.sessionId!==original.sessionId,cachedReplayStaleAudioFrames:staleFrames});
   await receiver.disconnect();await newDevice.disconnect();await leave(second,laptop.accessToken);await leave(other,listener.accessToken);
  }
  if(!baseline){
   const other=await join(R,listener.accessToken);let receiver=await connect(other);const phoneJoin=await join();const old=await connect(phoneJoin);await audio(old);const cached=old.token!;
   assert.equal((await request(R,'join',laptop.accessToken)).value.state,'elsewhere');
   const takeover=await request(R,'takeover',laptop.accessToken,{owner:owner(phoneJoin)});assert.equal(takeover.status,200,JSON.stringify(takeover.value));
   assert.equal((await request(R,'join',phone.accessToken,{expectedCallId:phoneJoin.call.id})).value.state,'replaced');
   await receiver.disconnect();const rejoined=await join(R,listener.accessToken,{expectedCallId:other.call.id});receiver=await connect(rejoined);const fresh=await connect(takeover.value);await audio(fresh);
   const staleIdentity=JSON.parse(Buffer.from(phoneJoin.token.split('.')[1]!,'base64url').toString()).sub;const before=observed.get(staleIdentity)??0;const replays=[];
   for(const delay of [0,6000]){if(delay)await new Promise(r=>setTimeout(r,delay));for(const token of [phoneJoin.token,cached]){const attempt=new Room();clients.push(attempt);try{await attempt.connect(phoneJoin.url,token);throw Error('stale token rejoined');}catch(e){assert.match(String(e),/401|expired|404|not exist/);replays.push({delay,refreshed:token===cached,rejected:true});}}}
   assert.equal(observed.get(staleIdentity)??0,before);
   await leave(phoneJoin);await service.nativeStop(phoneJoin.call.id,phoneJoin.stopToken);
   await new Promise(r=>setTimeout(r,11000));
   const renewed=await request(R,'reconnect',laptop.accessToken,{owner:owner(takeover.value),expectedCallId:phoneJoin.call.id});assert.equal(renewed.status,200,JSON.stringify(renewed.value));assert.equal(renewed.value.epoch,takeover.value.epoch);
   await fresh.disconnect();const refreshedConnection=await connect(renewed.value);await audio(refreshedConnection);
   await leave(takeover.value,laptop.accessToken);assert.equal(await service.sessionCurrent(phoneJoin.call.id,H,renewed.value.sessionId,renewed.value.epoch),true);
   await leave(renewed.value,laptop.accessToken);await leave(rejoined,listener.accessToken);
   const acquisition=await Promise.all([request(R,'join',phone.accessToken),request(DM,'join',laptop.accessToken)]);
   assert.deepEqual(acquisition.map(r=>r.status).sort(),[200,409]);
   for (let index=0;index<acquisition.length;index++) if(acquisition[index]!.status===200)await leave(acquisition[index]!.value,index===0?phone.accessToken:laptop.accessToken);
   Object.assign(result,{database:postgres?'PostgreSQL':'PGlite',crossRoomAtomic:true,initialTokenTtlSeconds:10,reconnectAfterInitialTokenExpiry:true,replays,staleAudioFrames:0,replacedTerminal:true,reconnectRetainedEpoch:true,staleCleanupSafe:true});
  }
  }
  await mkdir('.voice-proof/account-owner',{recursive:true});await writeFile(`.voice-proof/account-owner/${baseline?'built-baseline':'built-fixed'}.json`,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
 }
}finally{if(process.env.VOICE_OWNER_ANDROID!=='1')await close();}

}
void main().then(()=>process.exit(0), error=>{console.error(error);process.exit(1);});
