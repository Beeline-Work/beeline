/** Real Room-list taps, existing native paint probe and unchanged fixture APKs. */
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { startControl } from './control.mjs';
import { androidArtifact } from './android-artifact.mjs';
import { rooms, workspace, hash, agents, fixtureFingerprint, localDatabase } from './fixture.mjs';
import { pointFor } from '../latency-rig/capture-ui.mjs';
import { transitionMetrics } from './transition-metrics.mjs';
const device = process.env.LATENCY_RIG_DEVICE;
if (!/^(emulator-\d+|127\.0\.0\.1:\d+)$/.test(device ?? '')) throw new Error('Owned emulator required');
const output = process.argv[2];
await mkdir(output, { recursive: true });
const adb = (...args) => execFileSync('adb', ['-s',device,...args], {encoding:'utf8',maxBuffer:32e6});
if (adb('shell','getprop','ro.kernel.qemu').trim() !== '1') throw new Error('Disposable emulator required');
const artifact = androidArtifact(adb);
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
const tap = point => { if (!point) throw new Error('Required UI control missing'); adb('shell','input','tap',...point.map(String)); };
const dump = () => {
  for (let i=0;i<3;i++) {
    try { adb('shell','uiautomator','dump','/sdcard/room-transition.xml'); return adb('shell','cat','/sdcard/room-transition.xml'); }
    catch(error) { if(i===2) throw error; }
  }
};
const db = new pg.Client({connectionString:localDatabase(process.env.LATENCY_RIG_DATABASE_URL)});
await db.connect();
const markers = rooms.map(room=>hash(`transition-marker:${room}`));
try {
  // Identical disposable scenario traffic in both arms, observed by the native
  // probe. The original deterministic transcript rows stay unchanged.
  for (const [i,room] of rooms.entries()) await db.query(
    'INSERT INTO messages(id,room_id,author_id,text,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING',
    [markers[i],room,agents[0],`Transition fixture ${markers[i].slice(0,16)}`,'2026-10-25T01:00:00Z']);
} finally { await db.end(); }
const control = startControl();
const samples=[];
const showList = async () => {
  let xml=dump();
  const back=pointFor(xml,'content-desc','Back to Rooms');
  if(back){tap(back);await pause(1200);xml=dump();}
  if(!xml.includes('content-desc="Transcript speed fixture — switch Workspace"')) {
    const header=[...xml.matchAll(/content-desc="([^"]*— switch Workspace)"/g)][0]?.[1];
    tap(pointFor(xml,'content-desc',header));await pause(300);
    tap(pointFor(dump(),'content-desc','Transcript speed fixture'));await pause(1200);xml=dump();
  }
  if(!pointFor(xml,'content-desc','all conversations'))throw new Error('Fixture Room list missing');
  return xml;
};
const pid=adb('shell','pidof','app.usebeeline').trim();
if(!/^\d+$/.test(pid))throw new Error('One app process required');
const tasks=adb('shell',`for task in /proc/${pid}/task/*; do read -r name < "$task/comm"; if [ "$name" = mqt_v_js ]; then echo "\${task##*/}"; fi; done`).trim();
if(!/^\d+$/.test(tasks))throw new Error('One mqt_v_js thread required');
const calibrate=()=> {
  const out=adb('shell','echo $(date +%s%3N); cat /proc/uptime').trim().split(/\s+/).map(Number);
  return out[0]-out[1]*1000;
};
try {
  // The measurement runtime is loaded by the transcript route, not the list.
  adb('shell','am','start','-W','-a','android.intent.action.VIEW','-d',
    `beeline://beeline/chat/${rooms[0]}?communityId=${workspace}`,'app.usebeeline/.MainActivity');
  await pause(3000);
  await control.ready();
  // Visit both Rooms outside timing; the requested scenario is warm switching.
  for(let i=0;i<2;i++){tap(pointFor(await showList(),'text',`#Transcript ${i?'B':'A'}`));await pause(2500);}
  for(let repeat=0;repeat<6;repeat++){
    const index=repeat%2;
    const point=pointFor(await showList(),'text',`#Transcript ${index?'B':'A'}`);
    if(!point)throw new Error('Target Room row missing');
    adb('logcat','-c');
    adb('shell','am','broadcast','-a','app.usebeeline.LATENCY_RIG_EXPECT','-n','app.usebeeline/.LatencyRigReceiver',
      '--es','needle',markers[index].slice(0,16),'--es','case',`transition-${repeat}`,'--es','entry','room-list');
    const epochOffset=calibrate();
    let cpuText='';
    const monitor=spawn('adb',['-s',device,'shell',`while true; do read -r up rest < /proc/uptime; read -r run delay slices < /proc/${pid}/task/${tasks}/schedstat; echo "$up $run $delay"; sleep 0.02; done`]);
    monitor.stdout.on('data',chunk=>cpuText+=chunk);
    let raw;
    try {raw=await control.capture(`room-transition-${repeat}`,10000,async()=>{await pause(600);tap(point);});}
    finally {monitor.kill('SIGTERM');}
    const log=adb('logcat','-d','-v','epoch','-s','ReactNativeJS:V','LATENCY_NATIVE:W');
    await writeFile(`${output}/trial-${repeat}.log`,log);
    const native=[...log.matchAll(/LATENCY_VISIBLE (\{.*\})/g)].map(x=>JSON.parse(x[1])).find(x=>x.case===`transition-${repeat}`);
    if(!native || native.profiled)throw new Error('Unprofiled native transcript paint proof missing');
    const marks=log.split('\n').flatMap(line=>{
      const time=line.match(/^\s*(\d{10}\.\d+)/),mark=line.match(/\[ROOM_OPEN\]\s*(\{.*\})/);
      return time&&mark?[{epochMs:Number(time[1])*1000,...JSON.parse(mark[1])}]:[];
    });
    if(!marks.some(x=>x.phase==='newest-frame'))throw new Error('Room JS frame marker missing');
    const offsets=marks.map(x=>x.epochMs-x.t).sort((a,b)=>a-b);
    const clockOffsetMs=offsets[Math.floor(offsets.length/2)];
    if(offsets.at(-1)-offsets[0]>25)throw new Error(`JS/native clock alignment spread too large: ${offsets.at(-1)-offsets[0]}`);
    const cpu=cpuText.trim().split('\n').flatMap(line=>{
      const v=line.trim().split(/\s+/).map(Number);
      return v.length===3&&v.every(Number.isFinite)?[{epochMs:v[0]*1000+epochOffset,runtimeNs:v[1],schedulerWaitNs:v[2]}]:[];
    });
    const metrics=transitionMetrics(raw,native,clockOffsetMs,cpu);
    const xml=dump();
    if(!xml.includes(markers[index].slice(0,16)))throw new Error('Target transcript marker is not visible');
    samples.push({repeat,room:rooms[index],native,marks,clockOffsetMs,clockAlignmentSpreadMs:offsets.at(-1)-offsets[0],metrics,raw,cpu});
    await writeFile(`${output}/capture.json`,JSON.stringify({status:'running',samples},null,2));
    console.log(repeat,JSON.stringify(metrics));
  }
  if(process.env.TRANSCRIPT_PROFILE_SWITCH==='1'){
    const point=pointFor(await showList(),'text','#Transcript A');
    adb('logcat','-c');
    adb('shell','am','broadcast','-a','app.usebeeline.LATENCY_RIG_PROFILE','-n','app.usebeeline/.LatencyRigReceiver','--es','action','start');
    const profiled=await control.capture('profile-room-switch',8000,async()=>{await pause(600);tap(point);});
    adb('shell','am','broadcast','-a','app.usebeeline.LATENCY_RIG_PROFILE','-n','app.usebeeline/.LatencyRigReceiver','--es','action','stop');
    await writeFile(`${output}/profile.json`,adb('shell','cat','/sdcard/Android/data/app.usebeeline/files/latency-profile.json'));
    await writeFile(`${output}/profile-frames.json`,JSON.stringify(profiled,null,2));
    await writeFile(`${output}/profile.log`,adb('logcat','-d','-v','epoch','-s','ReactNativeJS:V','LATENCY_PROFILE:W'));
  }
  await writeFile(`${output}/capture.json`,JSON.stringify({status:'complete',device,fixtureFingerprint,...artifact,
    method:'Real Room-list ACTION_UP to native transcript frame commit followed by 500ms without a JS frame interval above 50ms. Six warm taps alternating A/B. JS busy time is mqt_v_js CPU runtime (schedstat) within the same window; scheduler wait is not busy CPU.',
    timingBounds:'The unchanged APK sampler omits its first rAF timestamp. Frame placement is bounded by the residual sample duration; both extremes and midpoint are retained. JS/native log clock offset spread and CPU boundary sampling bounds are retained.',
    scenarioMarkerIds:markers,samples},null,2));
}finally{control.close();}
