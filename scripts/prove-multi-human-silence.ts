/** Isolated Android proof: real RTC, database and native deadlines; injected STT/brain/TTS. */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Room, AudioSource, LocalAudioTrack, TrackPublishOptions, TrackSource, RoomEvent } from '@livekit/rtc-node';
import { PgliteDatabase } from '../apps/server/src/test-support.js';
import { migrate } from '../apps/server/src/database.js';
import { LiveHub } from '../apps/server/src/live.js';
import { VoiceService } from '../apps/server/src/voice-service.js';
import type { FluxEvent } from '../apps/server/src/voice-providers.js';
async function main() {
const H = 'a'.repeat(64), SECOND = 'd'.repeat(64), A = 'b'.repeat(64), W = randomUUID(), R = randomUUID();
const db = new PgliteDatabase();
await migrate(db);
await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Alex','alex'),($2,'human','Sam','sam'),($3,'agent','Ruby','ruby')`,[H,SECOND,A]);
await db.query(`INSERT INTO agents(agent_id,owner_id,soul) VALUES($1,$2,'{}')`,[A,H]);
await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Isolated silence proof')`,[W]);
await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Silence proof')`,[R,W]);
for (const id of [H,SECOND,A]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`,[W,id,R]);
const inputs: ((event: FluxEvent) => void)[] = [];
const operations: string[] = [];
const microphoneFrames: number[] = [];
const replies: string[] = [], signals: unknown[] = [], observations: unknown[] = [];
const Service: typeof VoiceService = process.env.SILENCE_PROOF_OLD === '1'
  ? (await import('../apps/server/src/' + '.silence-proof-old-service.js')).VoiceService : VoiceService;
const service = new Service(db,new LiveHub(),{url:'ws://127.0.0.1:17890',apiKey:'devkey',apiSecret:'secret',
  brain:{async answer(agent, _history,onText){ replies.push(agent.name); onText('Ready.'); return {text:'Ready.',order:false}; }},
  speech:{voices:['luna'], async *synthesize(){ const pcm = Buffer.alloc(4800); for(let i=0;i<2400;i++) pcm.writeInt16LE(Math.round(2000*Math.sin(i/8)),i*2); yield pcm; }},
  stt:async onEvent => { inputs.push(onEvent); const index=microphoneFrames.push(0)-1; return {send(){microphoneFrames[index]!++;},close(){}}; },
});
const first = await service.join(R,H);
const client = new Room();
client.on(RoomEvent.DataReceived, bytes => { try { signals.push(JSON.parse(new TextDecoder().decode(bytes))); } catch {} });
await client.connect(first.url,first.token);
const source = new AudioSource(16000,1);
const options = new TrackPublishOptions(); options.source=TrackSource.SOURCE_MICROPHONE;
await client.localParticipant!.publishTrack(LocalAudioTrack.createAudioTrack('Alex',source),options);
const callRow = (await db.query<any>(`SELECT * FROM voice_calls WHERE id=$1`,[first.call.id])).rows[0];
const runtime = (await service.ensureRuntime(callRow))!;
await runtime.utterance(H,'Ruby, ready?');
let turn=0;
const server = createServer((req,res)=> { void (async()=>{
  let raw=''; for await (const chunk of req) raw+=String(chunk);
  const body = raw ? JSON.parse(raw) : {};
  if (/\/(idle|resume|leave|state)/.test(req.url ?? '')) operations.push(req.url!);
  let value: unknown = {};
  if(req.url==='/fixture') value={roomId:R};
  else if(req.url==='/observe') { observations.push(body); value={}; }
  else if(req.url==='/result') value={humans:await service.humanCount(first.call.id),operations,microphoneFrames,replies,signals,observations,
    secondMicrophone:[...(client.remoteParticipants.get(SECOND)?.trackPublications.values() ?? [])].map(p=>({muted:p.muted,kind:p.kind})),
    participants:(await db.query(`SELECT identity_id,parked_at,left_at FROM voice_participants WHERE call_id=$1`,[first.call.id])).rows};
  else if(req.url==='/say') { await runtime.utterance(H,body.text??'How are you doing today?'); }
  else if(req.url==='/stop') { inputs.at(-1)?.({event:'EndOfTurn',turn_index:++turn,sequence_id:turn,transcript:'stop',words:[{word:'stop',start:0,end:.3,confidence:.99}]}); }
  else if(req.url==='/first-leave') await service.leave(first.call.id,H);
  else if(req.url?.endsWith('/join')) { const joined=await service.join(R,SECOND); value={...joined,url:'ws://10.0.2.2:17890'}; }
  else if(req.url?.endsWith('/idle')) value=await service.idle(first.call.id,SECOND,body.sessionId);
  else if(req.url?.includes('/state')) value=await service.idleState(first.call.id,SECOND,db,body.sessionId);
  else if(req.url?.endsWith('/resume')) await service.resume(first.call.id,SECOND,body.sessionId);
  else if(req.url?.endsWith('/leave')) await service.leave(first.call.id,SECOND,false,body.sessionId);
  else throw new Error('Unknown proof endpoint');
  res.setHeader('content-type','application/json'); res.end(JSON.stringify(value));
})().catch(error=>{res.statusCode=500;res.end(JSON.stringify({error:String(error)}));}); });
server.listen(18097,'127.0.0.1',()=>console.log('SILENCE-PROOF ready',process.env.SILENCE_PROOF_OLD==='1'?'old':'fixed'));
async function close(){ server.close(); await client.disconnect(); await service.close(); await db.close(); process.exit(); }
process.on('SIGTERM',()=>void close()); process.on('SIGINT',()=>void close());

}
void main().catch(error => { console.error(error); process.exit(1); });
