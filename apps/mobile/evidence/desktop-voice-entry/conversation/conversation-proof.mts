import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { dispose } from '@livekit/rtc-node';
import { PgliteDatabase } from '../apps/server/src/test-support.js';
import { migrate } from '../apps/server/src/database.js';
import { TokenAuth } from '../apps/server/src/auth.js';
import { PhoneService } from '../apps/server/src/phone-service.js';
import { DaemonService } from '../apps/server/src/daemon-service.js';
import { LiveHub } from '../apps/server/src/live.js';
import { VoiceService } from '../apps/server/src/voice-service.js';
import { createBeelineServer } from '../apps/server/src/server.js';
import { webProofShims } from '../apps/mobile/sources/test/browserProof.js';
const {chromium,webkit}=await import('/var/tmp/beeline-webkit-proof/node_modules/playwright/index.mjs');
const ROOT=process.cwd(),mobile=path.join(ROOT,'apps/mobile'),out=path.join(ROOT,'.voice-proof');
const H='a'.repeat(64),A='b'.repeat(64),B='c'.repeat(64),W=randomUUID(),R=randomUUID();
const db=new PgliteDatabase(),live=new LiveHub();
let activeInput:any;
const received:any[]=[],brainCalls:any[]=[],syntheses:any[]=[],reports:any[]=[];
const service=new VoiceService(db,live,{
  url:'ws://127.0.0.1:17886',apiKey:'devkey',apiSecret:'secret',
  stt:async(onEvent:any)=>{const input={onEvent,samples:0,nonzero:0,closed:false};activeInput=input;received.push(input);
    return {send(pcm:Int16Array){input.samples+=pcm.length;for(const sample of pcm)if(Math.abs(sample)>100)input.nonzero++;},close(){input.closed=true;}};},
  brain:{async answer(agent:any,history:any,onText:any){const text=`Hello I am ${agent.name} and this is my reply.`;brainCalls.push({agent:agent.name,input:history.at(-1).content});onText(text);return{text,order:false};}},
  speech:{voices:['luna','apollo'],async *synthesize(text:string,voice:string,signal:AbortSignal){
    const who=text.includes('Sol')?'Sol':'Ruby';const bytes=await readFile(path.join(out,`reply-${who}.pcm`));syntheses.push({who,voice,bytes:bytes.length});
    for(let at=0;at<bytes.length;at+=4800){if(signal.aborted)throw new DOMException('interrupted','AbortError');yield bytes.subarray(at,at+4800);}
  }},
});
const auth=new TokenAuth(db,async token=>({subject:token,login:token,name:token}));
let token='',origin='',api:any,browser:any;
const ui=createServer(async(req,res)=>{try{
  if(req.url==='/bundle.js'){res.setHeader('content-type','application/javascript');res.end(await readFile(path.join(out,'bundle.js')));return;}
  if(req.url?.startsWith('/human-')){const who=req.url.includes('Sol')?'Sol':'Ruby';res.setHeader('content-type','audio/wav');res.end(await readFile(path.join(out,`human-${who}.wav`)));return;}
  res.setHeader('content-type','text/html');res.end(`<!doctype html><meta charset="utf-8"><div id="root"></div><script>window.__proof=${JSON.stringify({origin,roomId:R,token})}</script><script src="/bundle.js"></script>`);
}catch{res.writeHead(500);res.end('proof fixture failure');}});
const clean=(value:any)=>String(value).replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g,'[token]').replace(/Bearer\s+\S+/gi,'Bearer [redacted]');
async function until(check:()=>boolean,label:string,timeout=20000){const start=Date.now();while(!check()){assert(Date.now()-start<timeout,`Timeout: ${label}`);await new Promise(r=>setTimeout(r,100));}}
try{
  await migrate(db);
  await db.query(`INSERT INTO identities(id,kind,name,handle) VALUES($1,'human','Alex','alex'),($2,'agent','Ruby','ruby'),($3,'agent','Sol','sol')`,[H,A,B]);
  await db.query(`INSERT INTO identity_external_links(provider,subject,identity_id,issuer,audience,provider_login) VALUES('github','alex',$1,'https://github.com','beeline','alex')`,[H]);
  await db.query(`INSERT INTO agents(agent_id,owner_id,soul) VALUES($1,$3,'{"instructions":"Voice: luna"}'),($2,$3,'{"instructions":"Voice: apollo"}')`,[A,B,H]);
  await db.query(`INSERT INTO workspaces(id,name) VALUES($1,'BBC isolated Conversation proof')`,[W]);
  await db.query(`INSERT INTO rooms(id,workspace_id,name) VALUES($1,$2,'Conversation proof')`,[R,W]);
  for(const who of [H,A,B])await db.query(`INSERT INTO memberships(workspace_id,room_id,identity_id,role) VALUES($1,NULL,$2,'owner'),($1,$3,$2,'member')`,[W,who,R]);
  token=(await auth.exchangeGitHubOidc('alex')).accessToken;
  await new Promise<void>(resolve=>ui.listen(0,'127.0.0.1',resolve));
  const uiOrigin=`http://127.0.0.1:${(ui.address() as any).port}`;
  api=createBeelineServer({database:db,auth,phone:new PhoneService(db,'http://proof'),daemon:new DaemonService(db,live),live,voice:service,mediaMaximumBytes:1024*1024,webAppOrigins:[uiOrigin]});
  await new Promise<void>(resolve=>api.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${api.address().port}`;
  const shims={...webProofShims(mobile),
    '@/constants/Typography':'export const Typography={default:()=>({})};',
    '@/auth/monolith-session':`export const monolithSession={fetch:(url,init)=>fetch(url,{...init,headers:{...init?.headers,authorization:'Bearer '+window.__proof.token}})};`,
    './runtime-config':'export const getBuzzRuntimeConfig=()=>({monolithUrl:window.__proof.origin});',
    './speech-locale':"export const getDeviceSpeechLocale=()=> 'en-US';",
    expo:`export class NativeModule {addListener(){return{remove(){}}}}; export const registerWebModule=M=>new M(); export const useEventListener=()=>{};`,
  };
  await build({entryPoints:[path.join(mobile,'.voice-proof/bbc/entry.tsx')],outfile:path.join(out,'bundle.js'),bundle:true,platform:'browser',jsx:'automatic',mainFields:['browser','module','main'],resolveExtensions:['.web.tsx','.web.ts','.web.js','.tsx','.ts','.js','.json'],loader:{'.js':'jsx','.png':'dataurl','.ttf':'dataurl'},define:{'process.env.NODE_ENV':'"development"','process.env.EXPO_OS':'"web"',__DEV__:'true',global:'globalThis'},plugins:[{name:'proof',setup(es){es.onResolve({filter:/.*/},({path:requested})=>{
    if(requested in shims)return{path:requested,namespace:'shim'};
    if(requested==='react-native')return{path:path.join(mobile,'node_modules/react-native-web/dist/index.js')};
    if(requested.startsWith('@/')){const candidate=path.join(mobile,'sources',requested.slice(2));return{path:['','.web.ts','.web.tsx','.ts','.tsx','.json','/index.ts','/index.tsx'].map(ext=>candidate+ext).find(p=>existsSync(p)&&statSync(p).isFile())!};}
  });es.onLoad({filter:/.*/,namespace:'shim'},({path:p})=>({contents:shims[p],loader:'tsx',resolveDir:mobile}));}}]});
  for(const engine of ['chrome','webkit']){
    const result:any={engine,head:'324d951ea0cbbcc0ecfe8da5ec8616d379e6ee71',providers:'scripted STT and brain; local flite speech PCM fixtures',steps:[],errors:[]};reports.push(result);
    const beforeBrain=brainCalls.length,beforeSpeech=syntheses.length;
    try{
      browser=engine==='chrome'?await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--autoplay-policy=no-user-gesture-required']}):await webkit.launch({executablePath:'/home/alan/.cache/ms-playwright/webkit-2311/pw_run.sh',headless:true});
      const page=await browser.newPage({viewport:{width:1100,height:800}});page.setDefaultTimeout(18000);
      page.on('pageerror',e=>result.errors.push(clean(e.message)));
      await page.addInitScript(()=>{
        window.__captures=[];window.__tracks=[];
        const devices=navigator.mediaDevices;Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:devices});
        devices.getUserMedia=async constraints=>{
          window.__captures.push(constraints);
          const ctx=new AudioContext();await ctx.resume();const destination=ctx.createMediaStreamDestination();
          window.__say=async who=>{const bytes=await(await fetch('/human-'+who+'.wav')).arrayBuffer();const audio=await ctx.decodeAudioData(bytes);const source=ctx.createBufferSource();source.buffer=audio;source.connect(destination);source.start();await new Promise(resolve=>{source.onended=resolve;});};
          const stream=destination.stream;window.__tracks.push(...stream.getTracks());
          for(const track of stream.getTracks()){const stop=track.stop.bind(track);track.stop=()=>{stop();void ctx.close();};}
          return stream;
        };
      });
      await page.goto(uiOrigin);
      result.capabilities=await page.evaluate(()=>({userAgent:navigator.userAgent,RTC:typeof RTCPeerConnection,SpeechRecognition:typeof SpeechRecognition,webkitSpeechRecognition:typeof webkitSpeechRecognition}));
      const mic=page.locator('[data-testid="chat-mic"]');await mic.waitFor();
      const bounds=await mic.boundingBox();await page.mouse.move(bounds!.x+bounds!.width/2,bounds!.y+bounds!.height/2);await page.mouse.down();await page.waitForTimeout(1000);await page.mouse.up();
      await page.waitForFunction(()=>window.__state.call||window.__state.error);
      result.join=await page.evaluate(()=>window.__state);
      assert(result.join.call,`join failed: ${result.join.error}`);result.steps.push('real composer long press joined actual LiveKit call');
      await until(()=>Boolean(activeInput&&!activeInput.closed),'server RTC microphone subscription');
      const input=activeInput;
      for(const [turn,who,id] of [[0,'Ruby',A],[1,'Sol',B]] as const){
        const previous=input.nonzero;
        await page.evaluate(who=>window.__say(who),who);
        await until(()=>input.nonzero>previous+100,'captured spoken fixture reached server STT boundary');
        input.onEvent({event:'EndOfTurn',transcript:`${who}, please say hello.`,turn_index:turn,sequence_id:turn+1});
        await page.waitForFunction(id=>window.__state.target===id,id);
        await until(()=>brainCalls.length>=beforeBrain+turn+1&&syntheses.length>=beforeSpeech+turn+1,'real runtime name routing and speech publication');
        await page.waitForFunction(()=>[...document.querySelectorAll('audio[data-beeline-voice-audio]')].some(a=>!a.paused&&a.currentTime>0));
        const playback=await page.evaluate(async()=>{
          const element=document.querySelector('audio[data-beeline-voice-audio]');const ctx=new AudioContext();await ctx.resume();
          const source=ctx.createMediaStreamSource(element.srcObject);const analyser=ctx.createAnalyser();source.connect(analyser);const values=new Float32Array(analyser.fftSize);
          let peak=0;for(let i=0;i<25;i++){analyser.getFloatTimeDomainData(values);for(const v of values)peak=Math.max(peak,Math.abs(v));await new Promise(r=>setTimeout(r,40));}
          source.disconnect();await ctx.close();return{peak,currentTime:element.currentTime,paused:element.paused};
        });
        assert(playback.peak>0.001,`${who} no decoded audio energy`);
        await page.screenshot({path:path.join(out,`${engine}-${who}.png`)});
        result.steps.push({agent:who,scriptedTranscript:`${who}, please say hello.`,serverNonzeroMicSamples:input.nonzero,playback});
        await page.waitForFunction(()=>window.__state.speaker===null);
      }
      await page.locator('[data-testid="voice-mic"]').click();
      await page.waitForFunction(()=>!window.__state.call&&!window.__state.connecting);
      await until(()=>input.closed,'server microphone cleanup');
      await page.waitForTimeout(500);
      result.cleanup=await page.evaluate(()=>({tracks:window.__tracks.map(t=>t.readyState),captureConstraints:window.__captures,
        audioElements:[...document.querySelectorAll('audio[data-beeline-voice-audio]')].map(a=>({paused:a.paused,currentTime:a.currentTime,readyState:a.readyState,srcObject:a.srcObject===null?'null':'stream',remoteTracks:a.srcObject?.getTracks().map(t=>t.readyState)??[]})),call:window.__state.call??null}));
      await page.waitForTimeout(1000);
      result.cleanup.laterAudio=await page.evaluate(()=>[...document.querySelectorAll('audio[data-beeline-voice-audio]')].map(a=>({currentTime:a.currentTime,readyState:a.readyState,srcObject:a.srcObject===null?'null':'stream'})));
      assert(result.cleanup.audioElements.every(a=>a.remoteTracks.every(state=>state==='ended')),'live remote audio after stop');
      assert(result.cleanup.tracks.every(s=>s==='ended'),'capture track leak');
      result.brainCalls=brainCalls.slice(beforeBrain);result.syntheses=syntheses.slice(beforeSpeech);result.serverInput={samples:input.samples,nonzero:input.nonzero,closed:input.closed};
      await page.screenshot({path:path.join(out,`${engine}-stopped.png`)});result.status='PASS fixture-provider integration';
    }catch(error){result.status='BLOCKED';result.failure=clean(error instanceof Error?error.message:error);}
    finally{await browser?.close();browser=null;}
    await writeFile(path.join(out,'result.json'),JSON.stringify(reports,null,2));
    console.log(JSON.stringify(result,null,2));
  }
}finally{
  await browser?.close();await service.close();ui.closeAllConnections();api?.closeAllConnections();
  await Promise.all([new Promise(r=>ui.close(r)),api?new Promise(r=>api.close(r)):Promise.resolve()]);await db.close();dispose();
}
