/** Seed a real Room for Android owner review. Local PGlite/RTC only; no production data.
 * Run with SILENCE_PROOF_ANDROID_FIRST=1 SILENCE_PROOF_HOLD=1.
 * HTTP routes bind only to localhost. /work-finish releases the initial call work.
 */
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Room, AudioSource, LocalAudioTrack, TrackPublishOptions, TrackSource, RoomEvent } from '@livekit/rtc-node';
import { PgliteDatabase } from '../apps/server/src/test-support.js';
import { PhoneService } from '../apps/server/src/phone-service.js';
import { routeHumanMessage } from '../apps/server/src/agent-command.js';
import { migrate } from '../apps/server/src/database.js';
import { LiveHub } from '../apps/server/src/live.js';
import { VoiceService } from '../apps/server/src/voice-service.js';
import type { FluxEvent } from '../apps/server/src/voice-providers.js';
async function main() {
const H = 'a'.repeat(64), SECOND = 'd'.repeat(64), A = 'b'.repeat(64), W = '509a0dfc-ee35-4b11-bd34-014794153d20', R = '375ebf52-b493-4982-bd6d-f3b8fe814a62';
const db = new PgliteDatabase();
await migrate(db);
await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Alex','alex'),($2,'human','Sam','sam'),($3,'agent','Ruby','ruby')`,[H,SECOND,A]);
await db.query(`INSERT INTO agents(agent_id,owner_id,soul) VALUES($1,$2,'{}')`,[A,H]);
await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Beeline')`,[W]);
await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Experiments')`,[R,W]);
for (const id of [H,SECOND,A]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`,[W,id,R]);
for (const [name, text, minutes] of [['General','The stand-up notes are ready for tomorrow.',12],['Design','The revised call controls use our existing brass and ink.',28],['Mobile','Android checks are complete. Ready for review.',45],['Launch','We will keep the release on hold until the owner is ready.',80]] as const) {
  const room = randomUUID();
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,$3)`,[room,W,name]);
  for (const id of [H,SECOND,A]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,$2,$3,'member')`,[W,room,id]);
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES($1,$2,$3,$4,now()-($5::text||' minutes')::interval)`,[randomUUID().replaceAll('-','').padEnd(64,'0'),room,SECOND,text,minutes]);
}
for (const [who,text,minutes] of [[H,'Morning! Let’s use this call for the mobile stand-up.',8],[SECOND,'Sounds good. I have the Android checks ready.',7],[A,'The call changes are ready to walk through together.',6],[H,'Great. Sam, what did you find in the latest build?',5],[SECOND,'The Room stays open while I listen. Let’s check the end controls next.',4]] as const) {
 await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES($1,$2,$3,$4,now()-($5::text||' minutes')::interval)`,[randomUUID().replaceAll('-','').padEnd(64,'0'),R,who,text,minutes]);
}
for (let index=0;index<18;index++) {
  const who=index%2?SECOND:H;
  const notes=['I checked the Room list on the latest build.','The Android microphone control stays in the same place.','Let’s keep the call open while everyone listens.','I will add the review notes here after the stand-up.'];
  await db.query(`INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES($1,$2,$3,$4,now()-($5::text||' minutes')::interval)`,[randomUUID().replaceAll('-','').padEnd(64,'0'),R,who,notes[index%notes.length],50-index]);
}
const phone=new PhoneService(db,'http://10.0.2.2:18097');
const inputs: ((event: FluxEvent) => void)[] = [];
const operations: string[] = [];
const microphoneFrames: number[] = [];
let speechMs = 100;
const replies: string[] = [], signals: unknown[] = [], observations: unknown[] = [];
const Service: typeof VoiceService = process.env.SILENCE_PROOF_OLD === '1'
  ? (await import('../apps/server/src/' + '.silence-proof-old-service.js')).VoiceService : VoiceService;
const live=new LiveHub();
const service = new Service(db,live,{url:'ws://127.0.0.1:17890',apiKey:'devkey',apiSecret:'secret',
  brain:{async answer(agent, _history,onText){ replies.push(agent.name); onText('Ready.'); return {text:'Ready.',order:false}; }},
  speech:{voices:['luna'], async *synthesize(){ const pcm = Buffer.alloc(speechMs * 48); for(let i=0;i<speechMs * 24;i++) pcm.writeInt16LE(Math.round(2000*Math.sin(i/8)),i*2); yield pcm; }},
  stt:async onEvent => { inputs.push(onEvent); const index=microphoneFrames.push(0)-1; return {send(){microphoneFrames[index]!++;},close(){}}; },
});
// Real deployments fan out committed database changes; the disposable rig sends the same invalidation.
for (const method of ['recordHuman','recordAnswer'] as const) {
  const original=service[method].bind(service) as (...args:any[])=>Promise<any>;
  (service as any)[method]=async (...args:any[])=>{const value=await original(...args);live.publish({type:'invalidate',roomId:R,reason:'voice-transcript'});return value;};
}
const nativeHuman = process.env.SILENCE_PROOF_ANDROID_FIRST === '1' ? H : SECOND;
const partner = nativeHuman === H ? SECOND : H;
const first = await service.join(R,partner);
let client = new Room();
const connectPartner = async (joined: Awaited<ReturnType<VoiceService['join']>>) => {
  client = new Room();
  client.on(RoomEvent.DataReceived, bytes => { try { signals.push(JSON.parse(new TextDecoder().decode(bytes))); } catch {} });
  await client.connect(joined.url,joined.token);
  const source = new AudioSource(16000,1);
  const options = new TrackPublishOptions(); options.source=TrackSource.SOURCE_MICROPHONE;
  await client.localParticipant!.publishTrack(LocalAudioTrack.createAudioTrack('Partner',source),options);
};
await connectPartner(first);
const callRow = (await db.query<any>(`SELECT * FROM voice_calls WHERE id=$1`,[first.call.id])).rows[0];
const runtime = (await service.ensureRuntime(callRow))!;
await runtime.utterance(partner,'Ruby, ready?');
if(process.env.SILENCE_PROOF_TIMING === '1') {
  for(let index=0;index<5;index++) await runtime.utterance(partner,'Ruby, ready?');
  await client.disconnect(); await service.close(); await db.close(); process.exit(0);
}
let turn=0; let workSource: string | undefined;
if(process.env.SILENCE_PROOF_HOLD === '1') {
  workSource=await service.recordHuman(first.call.id,R,partner,(await service.agents(R,partner))[0]!,'Check the Android call flow and let us know when you’re finished.');
  await service.dispatch(first.call.id,workSource,A); await runtime.refresh();
}
const server = createServer((req,res)=> { void (async()=>{
  let raw=''; for await (const chunk of req) raw+=String(chunk);
  const body = raw ? JSON.parse(raw) : {};
  if (/\/(idle|resume|leave|state)/.test(req.url ?? '')) operations.push(req.url!);
  let value: unknown = {};
  const url=new URL(req.url!,'http://localhost');
  console.log(req.method,url.pathname);
  if(req.url==='/fixture') value={roomId:R,workspaceId:W,humanId:H};
  else if(url.pathname==='/v1/phone/workspaces') value=await phone.readWorkspaces(H);
  else if(url.pathname===`/v1/phone/workspaces/${W}`) value=await phone.readWorkspace(W,H);
  else if(url.pathname===`/v1/phone/workspaces/${W}/chats`) value=await phone.readChats(W,H);
  else if(url.pathname===`/v1/phone/rooms/${R}`) value=await phone.readRoom(R,H);
  else if(url.pathname.endsWith('/welcome-cards')) value=await phone.readWelcomeCards(H);
  else if(url.pathname.includes('/operations/')) value=url.pathname.endsWith('workspaceGitHubAccess')?{installed:true,installations:[],candidates:[],githubReconnectNeeded:false}:{};
  else if(url.pathname.endsWith('/read')) { await phone.markRead(R,body.messageId,H); value={}; }
  else if(url.pathname.includes('/history')) value=await phone.readHistory(R,H);

  else if(req.url==='/observe') { observations.push(body); value={}; }
  else if(req.url==='/result') value={activeCallWork:await service.hasCallWork(first.call.id),pendingCommands:(await db.query<{count:number}>(`SELECT count(*)::int count FROM agent_commands WHERE state IN ('pending','claimed')`)).rows[0]!.count,call:(await db.query(`SELECT ended_at FROM voice_calls WHERE id=$1`,[first.call.id])).rows[0],card:(await new PhoneService(db,'http://proof').readRoom(R,H))?.messages.find(m=>m.voiceCall),humans:await service.humanCount(first.call.id),operations,microphoneFrames,replies,signals,observations,
    secondMicrophone:[...(client.remoteParticipants.get(SECOND)?.trackPublications.values() ?? [])].map(p=>({muted:p.muted,kind:p.kind})),
    participants:(await db.query(`SELECT identity_id,parked_at,left_at FROM voice_participants WHERE call_id=$1`,[first.call.id])).rows};
  else if(req.url==='/work-start' || req.url==='/outside-start') {
    const agent=(await service.agents(R,H))[0]!;
    workSource=await service.recordHuman(first.call.id,R,H,agent,'Work until finished');
    if(req.url==='/outside-start') await db.transaction(tx=>routeHumanMessage(tx,workSource!));
    else await service.dispatch(first.call.id,workSource,A);
    await runtime.refresh();
  }
  else if(req.url==='/work-finish') { await db.query(`UPDATE agent_commands SET state='complete',completed_at=now() WHERE source_message_id=$1`,[workSource]); await runtime.refresh(); }
  else if(req.url==='/say') { speechMs=body.speechMs??100; const current=await service.current(R,H); if(!current)throw new Error('No active call'); const row=(await db.query<any>('SELECT * FROM voice_calls WHERE id=$1',[current.id])).rows[0]; await (await service.ensureRuntime(row))!.utterance(H,body.text??'How are you doing today?'); speechMs=100; }
  else if(req.url==='/partner-leave') { await service.leave(first.call.id,partner); }
  else if(req.url==='/partner-rejoin') { await connectPartner(await service.join(R,partner)); }
  else if(req.url==='/partner-drop') { await client.disconnect(); }
  else if(req.url==='/partner-return') { await connectPartner(first); }
  else if(req.url==='/stop') { inputs.at(-1)?.({event:'EndOfTurn',turn_index:++turn,sequence_id:turn,transcript:'stop',words:[{word:'stop',start:0,end:.3,confidence:.99}]}); }
  else if(req.url==='/first-leave') await service.leave(first.call.id,H);
  else if(req.url?.endsWith('/join')) { const joined=await service.join(R,nativeHuman,body.expectedCallId); value={...joined,url:'ws://10.0.2.2:17890'}; }
  else if(req.url?.endsWith('/idle')) value=await service.idle(first.call.id,nativeHuman,body.sessionId);
  else if(req.url?.includes('/state')) value=await service.idleState(url.pathname.split('/').at(-2)!,nativeHuman,db,url.searchParams.get('sessionId')??undefined);
  else if(req.url?.endsWith('/resume')) await service.resume(first.call.id,nativeHuman,body.sessionId);
  else if(req.url?.endsWith('/leave')) await service.leave(url.pathname.split('/').at(-2)!,nativeHuman,false,body.sessionId);
  else throw new Error('Unknown proof endpoint');
  res.setHeader('content-type','application/json'); res.end(JSON.stringify(value));
})().catch(error=>{res.statusCode=500;res.end(JSON.stringify({error:String(error)}));}); });
const sockets=new WebSocketServer({server,path:'/v1/phone/live'});
sockets.on('connection',socket=>{socket.on('message',raw=>{const m=JSON.parse(String(raw));
 if(m.type==='ping')socket.send(JSON.stringify({type:'pong'}));
 if(m.type==='subscribe')for(const roomId of m.roomIds??[m.roomId])if(roomId)socket.send(JSON.stringify({type:'subscribed',roomId}));
 });});
live.subscribeAll(event=>{for(const socket of sockets.clients)if(socket.readyState===1)socket.send(JSON.stringify(event));});
server.listen(18097,'127.0.0.1',()=>console.log('SILENCE-PROOF ready',process.env.SILENCE_PROOF_OLD==='1'?'old':'fixed'));
async function close(){ server.close(); await client.disconnect(); await service.close(); await db.close(); process.exit(); }
process.on('SIGTERM',()=>void close()); process.on('SIGINT',()=>void close());

}
void main().catch(error => { console.error(error); process.exit(1); });
