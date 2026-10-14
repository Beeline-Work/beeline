/** Isolated native voice fixture: actual RTC/PCM and offline STT/TTS, no production accounts or provider billing. */
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { PgliteDatabase } from '../apps/server/src/test-support.js';
import { migrate } from '../apps/server/src/database.js';
import { TokenAuth } from '../apps/server/src/auth.js';
import { LiveHub } from '../apps/server/src/live.js';
import { VoiceService } from '../apps/server/src/voice-service.js';
import { PhoneService } from '../apps/server/src/phone-service.js';
import { DaemonService } from '../apps/server/src/daemon-service.js';
import { createBeelineServer } from '../apps/server/src/server.js';
import type { FluxEvent } from '../apps/server/src/voice-providers.js';

async function main() {
const H = 'a'.repeat(64), A = 'b'.repeat(64);
const W = '11111111-1111-4111-8111-111111111111', R = '22222222-2222-4222-8222-222222222222';
const run = promisify(execFile);
const db = new PgliteDatabase(), live = new LiveHub();
const metrics = { opened: 0, closed: 0, frames: 0, samples: 0, ttsSamples: 0, recognized: [] as string[], events: [] as {at:number;event:string}[] };
const note = (event: string) => { metrics.events.push({at:Date.now(),event}); if(metrics.events.length>100) metrics.events.shift(); console.log(event); };
const auth = new TokenAuth(db, async () => ({ subject: 'voice-proof', login: 'voice-proof', name: 'Voice proof' }));
let agentToken = '';
const voice = new VoiceService(db, live, {
  url: 'ws://127.0.0.1:26880', apiKey: 'devkey', apiSecret: 'secret',
  brain: { async answer(_agent, history, delta) {
    const order = /work/i.test(history.at(-1)?.content ?? '');
    const text = order ? 'I will work on that and reply when it is done.' : 'Hello. I can hear you with the screen off.';
    delta(text); return { text, order };
  } },
  speech: { async *synthesize(text) {
    const {stdout:wav} = await run('espeak-ng', ['-v','en-us','-s','155','--stdout',text], {encoding:'buffer',maxBuffer:2_000_000});
    const proc = spawn('ffmpeg',['-hide_banner','-loglevel','error','-i','pipe:0','-ar','24000','-ac','1','-f','s16le','pipe:1']);
    proc.stdin.end(wav);
    for await (const chunk of proc.stdout) { metrics.ttsSamples += chunk.length/2; yield chunk as Buffer; }
  } },
  stt: async onEvent => {
    const proc = spawn('python3',['scripts/voice-screen-off-stt.py'], {env:{...process.env,PYTHONPATH:'/tmp/voice-proof-python'},stdio:['pipe','pipe','pipe']});
    metrics.opened++; note('STT opened'); let closed=false; let pending='';
    proc.stderr.on('data', () => {});
    proc.stdin.on('error', () => {});
    proc.stdout.on('data', chunk => {
      pending += chunk.toString();
      for (let at; (at=pending.indexOf('\n'))>=0;) {
        const line=pending.slice(0,at); pending=pending.slice(at+1);
        const event=JSON.parse(line) as FluxEvent;
        metrics.recognized.push(event.transcript); note(`recognized ${event.transcript}`); onEvent(event);
      }
    });
    return {send(samples) { if (!closed) { metrics.frames++; metrics.samples+=samples.length; proc.stdin.write(Buffer.from(samples.buffer,samples.byteOffset,samples.byteLength)); } },
      close() { if (closed) return; closed=true; metrics.closed++; note('STT closed'); proc.stdin.destroy(); proc.kill(); } };
  },
});
const join = voice.join.bind(voice);
voice.join = async (...args) => ({...await join(...args), url: 'ws://10.0.2.2:26880'});
const dispatch = voice.dispatch.bind(voice);
voice.dispatch = async (...args) => {
  await dispatch(...args);
  const command=(await db.query<{id:string;turn_request_id:string}>(`SELECT id,turn_request_id FROM agent_commands WHERE source_message_id=$1 AND agent_id=$2`,[args[1],A])).rows[0];
  if (!command) throw new Error('Missing proof command');
  await operation('claimAgentCommand',{roomId:R,commandId:command.id,generationId:'voice-screen-off-proof'});
  note('worker claimed; report due after 35 seconds');
  setTimeout(() => { void (async () => {
    await mkdir('apps/mobile/.voice-proof/screen-off',{recursive:true});
    await writeFile('apps/mobile/.voice-proof/screen-off/greeting.txt','Hello Ruby');
    await operation('report',{roomId:R,requestId:command.turn_request_id,generationId:'voice-screen-off-proof',text:'done: I created the greeting file. Hello Ruby.'});
    live.publish({type:'invalidate',roomId:R,reason:'message',agentId:A,requestId:command.turn_request_id}); note('worker report committed');
  })().catch(error=>note(`worker failed: ${String(error)}`)); },35_000);
};
async function operation(name:string,input:unknown) {
  const response=await fetch(`http://127.0.0.1:18090/v1/daemon/operations/${name}`,{method:'POST',headers:{authorization:`Bearer ${agentToken}`,'content-type':'application/json'},body:JSON.stringify(input)});
  const result=await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result;
}
await migrate(db);
await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Proof Human','proofhuman'),($2,'agent','Ruby','ruby')`,[H,A]);
await db.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login) VALUES('github','voice-proof',$1,'https://github.com','beeline','voice-proof')`,[H]);
await db.query(`INSERT INTO agents(agent_id,owner_id,soul) VALUES($1,$2,'{"instructions":"Isolated proof worker."}')`,[A,H]);
await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'Isolated screen-off proof')`,[W]);
await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Screen-off proof')`,[R,W]);
for(const id of [H,A]) await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`,[W,id,R]);
agentToken=(await auth.exchangeDaemonToken((await auth.createDaemonExchange(A)).exchangeToken))!.daemonToken;
const app=createBeelineServer({database:db,auth,phone:new PhoneService(db,'http://127.0.0.1:18090'),daemon:new DaemonService(db,live),live,voice,mediaMaximumBytes:1_000_000,webAppOrigins:['http://localhost:18090']});
const server=createServer((request,response) => { void (async()=>{
  if(request.url?.startsWith('/proof/')) {
    response.setHeader('content-type','application/json');
    const messages=(await db.query<{text:string;author_id:string}>(`SELECT text,author_id FROM messages WHERE room_id=$1 AND presentation='message' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 12`,[R])).rows.reverse();
    response.end(JSON.stringify({roomId:R,...metrics,messages,call:await voice.current(R,H),participants:(await db.query(`SELECT parked_at,left_at FROM voice_participants ORDER BY joined_at DESC LIMIT 1`)).rows})); return;
  }
  app.emit('request',request,response);
})().catch(error=>{response.statusCode=500;response.end(JSON.stringify({error:String(error)}));}); });
server.on('upgrade',(request,socket,head)=>app.emit('upgrade',request,socket,head));
server.listen(18090,'127.0.0.1',()=>console.log('Isolated voice fixture ready on 18090'));
for(const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,()=>{void (async()=>{server.close();await voice.close();await db.close();process.exit(0);})();});

}
void main().catch(error => { console.error(error); process.exit(1); });
