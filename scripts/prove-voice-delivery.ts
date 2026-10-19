/** DELIVERY-2: disposable database, actual Android/RTC, injected provider responses.
 * Start local LiveKit on 17890, then run with SILENCE_PROOF_ANDROID_FIRST=1.
 * No production identity, credential or helper is used. Bind control HTTP to loopback.
 */
import { WebSocketServer } from 'ws';
import { createServer } from 'node:http';
import { Room, AudioStream, TrackKind, AudioSource, LocalAudioTrack, TrackPublishOptions, TrackSource, RoomEvent } from '@livekit/rtc-node';
import { PgliteDatabase } from '../apps/server/src/test-support.js';
import { PhoneService } from '../apps/server/src/phone-service.js';
import { migrate } from '../apps/server/src/database.js';
import { LiveHub } from '../apps/server/src/live.js';
import { VoiceRoomRuntime } from '../apps/server/src/voice-room-runtime.js';
import { VoiceService } from '../apps/server/src/voice-service.js';
import { claimAgentCommand, authorizeCommandOutput } from '../apps/server/src/agent-command.js';
import { DaemonService } from '../apps/server/src/daemon-service.js';
import { AuraSpeech, OpenRouterVoiceBrain } from '../apps/server/src/voice-providers.js';
import type { FluxEvent } from '../apps/server/src/voice-providers.js';
async function main() {
const B = 'c'.repeat(64);
const H = 'a'.repeat(64), SECOND = 'd'.repeat(64), A = 'b'.repeat(64), W = '509a0dfc-ee35-4b11-bd34-014794153d20', R = '375ebf52-b493-4982-bd6d-f3b8fe814a62';
const db = new PgliteDatabase();
await migrate(db);
await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Alex','alex'),($2,'human','Sam','sam'),($3,'agent','Ruby','ruby')`,[H,SECOND,A]);
await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'agent','Goosey','goose')`,[B]);
await db.query(`INSERT INTO agents(agent_id,owner_id,soul) VALUES($1,$2,'{}')`,[B,H]);
await db.query(`INSERT INTO agents(agent_id,owner_id,soul) VALUES($1,$2,'{}')`,[A,H]);
await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Beeline')`,[W]);
await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Experiments')`,[R,W]);
for (const id of [H,SECOND,A,B]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`,[W,id,R]);
const phone=new PhoneService(db,'http://10.0.2.2:18097');
const inputs: ((event: FluxEvent) => void)[] = [];
const operations: string[] = [];
const microphoneFrames: number[] = [];
let speechMs = 100;
let fault = '';
let holdSpeech = false;
const speechWaiters = new Set<() => void>();
let releaseDecision: (() => void) | undefined;
let decisionGate: Promise<void> | undefined;
let decisionRequests = 0;
const synthesis: {text: string; at: number}[] = [];
const deliveries: {source: string; at: number}[] = [];
const turns = new Map<string, number>();
let dispatchAttempts = 0;
const frameCounts = { received: 0 };
const replies: string[] = [], signals: unknown[] = [], observations: unknown[] = [];
if (process.env.VOICE_DELIVERY_BASELINE === '1') {
  const before = await import('../apps/server/src/' + '.voice-delivery-baseline.js');
  VoiceRoomRuntime.connect = before.VoiceRoomRuntime.connect;
}
const live=new LiveHub();
const service = new VoiceService(db,live,{url:'ws://127.0.0.1:17890',apiKey:'devkey',apiSecret:'secret',
  brain:new OpenRouterVoiceBrain('local-proof', async (_url, init) => {
    const input = JSON.parse(String(init!.body));
    const work = /build|check my latest report/.test(input.messages.at(-1).content);
    decisionRequests++;
    if (decisionGate && work) await decisionGate;
    const text = work ? 'Checking.' : 'Ready.';
    replies.push(text);
    return new Response('data: '+JSON.stringify({ choices: [{ delta: { content: text,
      ...(work ? { tool_calls: [{function:{name:'order'}}] } : {}) } }] })+'\n\n');
  }),
  speech:new AuraSpeech('local-proof','local-account', async (_url, init) => {
    if (holdSpeech) await new Promise<void>((resolve, reject) => {
      const finish = () => { speechWaiters.delete(finish); init?.signal?.removeEventListener('abort', abort); resolve(); };
      const abort = () => { speechWaiters.delete(finish); reject(new DOMException('Interrupted', 'AbortError')); };
      if (init?.signal?.aborted) abort();
      else { speechWaiters.add(finish); init?.signal?.addEventListener('abort', abort, { once: true }); }
    });
    synthesis.push({text: JSON.parse(String(init!.body)).text, at: Date.now()});
    if (fault === 'tts-fail') { fault = ''; throw new Error('Injected TTS failure'); }
    const pcm = Buffer.alloc(speechMs * 48);
    for(let i=0;i<speechMs * 24;i++) pcm.writeInt16LE(Math.round(2000*Math.sin(i/8)),i*2);
    return new Response(pcm);
  }),
  stt:async onEvent => { inputs.push(onEvent); const index=microphoneFrames.push(0)-1; return {send(){microphoneFrames[index]!++;},close(){}}; },
});
// Real deployments fan out committed database changes; the disposable rig sends the same invalidation.
for (const method of ['recordHuman','recordAnswer'] as const) {
  const original=service[method].bind(service) as (...args:any[])=>Promise<any>;
  (service as any)[method]=async (...args:any[])=>{const value=await original(...args);live.publish({type:'invalidate',roomId:R,reason:'voice-transcript'});return value;};
}
const originalDispatch = service.dispatch.bind(service);
service.dispatch = async (...args) => {
  dispatchAttempts++;
  await originalDispatch(...args);
  deliveries.push({source: args[1], at: Date.now()});
};
const nativeHuman = process.env.SILENCE_PROOF_ANDROID_FIRST === '1' ? H : SECOND;
const partner = nativeHuman === H ? SECOND : H;
const first = await service.join(R,partner);
let client = new Room();
const connectPartner = async (joined: Awaited<ReturnType<VoiceService['join']>>) => {
  client = new Room();
  client.on(RoomEvent.TrackSubscribed, track => {
    if (track.kind === TrackKind.KIND_AUDIO) {
      const reader = new AudioStream(track, 24000, 1).getReader();
      void (async () => { try { while (true) { const frame = await reader.read(); if (frame.done) break;
        if (frame.value.data.some(sample => Math.abs(sample) > 150)) frameCounts.received++;
      } } catch {} })();
    }
  });
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
const server = createServer((req,res)=> { void (async()=>{
  let raw=''; for await (const chunk of req) raw+=String(chunk);
  const bodyText = raw.replace(/\0/g, '').trim();
  const body = bodyText ? JSON.parse(bodyText) : {};
  if (/\/(idle|resume|leave|state)/.test(req.url ?? '')) operations.push(req.url!);
  let value: unknown = {};
  const url=new URL(req.url!,'http://localhost');
  console.log(req.method,url.pathname);
  if(req.url==='/speech-gate') {
    holdSpeech = !!body.hold;
    if (!holdSpeech) for (const finish of [...speechWaiters]) finish();
  }
  else if(req.url==='/brain-gate') {
    if (body.hold) decisionGate = new Promise<void>(resolve => { releaseDecision = resolve; });
    else { releaseDecision?.(); decisionGate = undefined; }
  }
  else if(req.url==='/delivery-fault') fault = body.kind;
  else if(req.url==='/segment') {
    const who = body.human === 'partner' ? partner : nativeHuman;
    const index = who === partner ? 0 : 1;
    if (!inputs[index]) throw new Error('Microphone STT not ready');
    const turn = (turns.get(who) ?? -1) + 1; turns.set(who, turn);
    const text = body.text;
    inputs[index]!({event: 'EndOfTurn', transcript: text, turn_index: turn, sequence_id: turn,
      words: text.split(' ').map((word: string, i: number) => ({word, start: i * .3, end: (i+1) * .3, confidence: .99}))});
  }
  else if(req.url==='/solo-proof') { await service.leave(first.call.id,partner); await client.disconnect(); }
  else if(req.url==='/claim-proof') {
    const command = (await db.query<{id:string;turn_request_id:string;agent_id:string}>(`SELECT id,turn_request_id,agent_id FROM agent_commands WHERE state='pending' ORDER BY created_at LIMIT 1`)).rows[0]!;
    await claimAgentCommand(db,R,command.agent_id,command.id,'continuation-proof');
    value = command;
  }
  else if(req.url==='/stale-proof') {
    try { await authorizeCommandOutput(db,R,body.agentId,body.requestId,'continuation-proof'); value={fenced:false}; }
    catch { value={fenced:true}; }
  }
  else if(req.url==='/report') {
    const command = (await db.query<{id:string; agent_id:string; source_message_id:string; turn_request_id:string}>(
      `SELECT c.id,c.agent_id,c.source_message_id,c.turn_request_id FROM agent_commands c JOIN voice_orders o
        ON o.source_message_id=c.source_message_id AND o.agent_id=c.agent_id
        WHERE o.call_id=$1 AND o.spoken_message_id IS NULL ORDER BY c.created_at LIMIT 1`, [first.call.id])).rows[0]!;
    const generation = `delivery-proof-${command.id}`;
    await claimAgentCommand(db,R,command.agent_id,command.id,generation);
    await new DaemonService(db,live).execute('postRoomMessage', {
      roomId:R, requestId:command.turn_request_id, generationId:generation, text:'The work is done.',
    }, command.agent_id);
    await runtime.refresh();
  }
  else if(req.url==='/fixture') value={roomId:R,workspaceId:W,humanId:H};
  else if(url.pathname==='/v1/phone/workspaces') value=await phone.readWorkspaces(H);
  else if(url.pathname===`/v1/phone/workspaces/${W}`) value=await phone.readWorkspace(W,H);
  else if(url.pathname===`/v1/phone/workspaces/${W}/chats`) value=await phone.readChats(W,H);
  else if(url.pathname===`/v1/phone/rooms/${R}`) value=await phone.readRoom(R,H);
  else if(url.pathname.endsWith('/welcome-cards')) value=await phone.readWelcomeCards(H);
  else if(url.pathname.includes('/operations/')) value=url.pathname.endsWith('workspaceGitHubAccess')?{installed:true,installations:[],candidates:[],githubReconnectNeeded:false}:{};
  else if(url.pathname.endsWith('/read')) { await phone.markRead(R,body.messageId,H); value={}; }
  else if(url.pathname.includes('/history')) value=await phone.readHistory(R,H);

  else if(req.url==='/observe') { observations.push(body); value={}; }
  else if(req.url==='/result') value={commandDetails:(await db.query(`SELECT id,turn_request_id,source_message_id,agent_id,state,reason FROM agent_commands WHERE room_id=$1`,[R])).rows,decisionRequests,synthesis,deliveries,orders:(await db.query(`SELECT o.*,m.text FROM voice_orders o JOIN messages m ON m.id=o.source_message_id`)).rows,transcript:(await phone.readRoom(R,H))?.messages.map(m=>({text:m.text,author:m.author.pubkey})),pid:process.pid,callId:runtime.callId,dispatchAttempts,frameCounts,commands:(await db.query(`SELECT count(*)::int count FROM agent_commands WHERE room_id=$1`,[R])).rows[0],activeCallWork:await service.hasCallWork(first.call.id),pendingCommands:(await db.query<{count:number}>(`SELECT count(*)::int count FROM agent_commands WHERE state IN ('pending','claimed')`)).rows[0]!.count,call:(await db.query(`SELECT ended_at FROM voice_calls WHERE id=$1`,[first.call.id])).rows[0],card:(await new PhoneService(db,'http://proof').readRoom(R,H))?.messages.find(m=>m.voiceCall),humans:await service.humanCount(first.call.id),operations,microphoneFrames,replies,signals,observations,
    secondMicrophone:[...(client.remoteParticipants.get(SECOND)?.trackPublications.values() ?? [])].map(p=>({muted:p.muted,kind:p.kind})),
    participants:(await db.query(`SELECT identity_id,parked_at,left_at FROM voice_participants WHERE call_id=$1`,[first.call.id])).rows};
  else if(req.url==='/say') { speechMs=body.speechMs??100; const current=await service.current(R,H); if(!current)throw new Error('No active call'); const row=(await db.query<any>('SELECT * FROM voice_calls WHERE id=$1',[current.id])).rows[0]; await (await service.ensureRuntime(row))!.utterance(H,body.text??'How are you doing today?'); speechMs=100; }
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
server.listen(18097,'127.0.0.1',()=>console.log('DELIVERY-2 ready'));
async function close(){ server.close(); await client.disconnect(); await service.close(); await db.close(); process.exit(); }
process.on('SIGTERM',()=>void close()); process.on('SIGINT',()=>void close());

}
void main().catch(error => { console.error(error); process.exit(1); });
