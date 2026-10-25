import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import pg from 'pg';
import {rooms,workspace,agents,localDatabase} from '../../scripts/transcript-speed/fixture.mjs';
import {fixtureStimulus} from '../../scripts/transcript-speed/stimulus.mjs';
const device=process.env.LATENCY_RIG_DEVICE;
if(!device?.startsWith('emulator-'))throw new Error('Select this corner emulator explicitly');
const adb=(...args)=>execFileSync('adb',['-s',device,...args],{encoding:'utf8',maxBuffer:16e6});
if(adb('shell','getprop','ro.kernel.qemu').trim()!=='1')throw new Error('Emulator required');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const open=id=>adb('shell','am','start','-W','-a','android.intent.action.VIEW','-d',`beeline://beeline/chat/${id}?communityId=${workspace}`,'app.usebeeline/.MainActivity');
const stimulus=await fixtureStimulus();
const db=new pg.Client({connectionString:localDatabase(process.env.LATENCY_RIG_DATABASE_URL)});await db.connect();
const results=[];
const before=Date.now(),deviceClockMs=Number(adb('shell','date','+%s%3N').trim()),after=Date.now();
const clock={deviceMinusHostMs:deviceClockMs-(before+after)/2,samplingErrorMs:(after-before)/2};
const frames=()=>adb('logcat','-d','-s','ReactNativeJS:I','*:S').split('\n').flatMap(line=>{
 const start=line.indexOf('[NET-HOL-1]');if(start<0)return [];
 try{return [JSON.parse(line.slice(line.indexOf('{', start), line.lastIndexOf('}') + 1))]}catch{return []}
});
try{
 for(const profile of [{name:'normal',rttMs:0,mbps:100},{name:'throttled',rttMs:150,mbps:1.6}]){
  await fetch('http://127.0.0.1:23881/__latency-rig/profile',{method:'POST',body:JSON.stringify({...profile,jitterMs:0,failureRate:0})});
  open(rooms[0]);await pause(2000);
  for(let trial=0;trial<3;trial++){
   adb('logcat','-c');
   const id=randomBytes(32).toString('hex');
   await db.query('INSERT INTO messages(id,room_id,author_id,text) VALUES($1,$2,$3,$4)',[id,rooms[1],agents[0],'Background audit payload '+'B'.repeat(128*1024)]);
   await pause(50);const actionAt=Date.now();const active=await stimulus.incoming(rooms[0]);
   let heard=[];
   for(let wait=0;wait<30;wait++){await pause(200);heard=frames();if(heard.some(f=>f.id===active.id))break;}
   const offscreen=heard.find(f=>f.id===id),activeFrame=heard.find(f=>f.id===active.id);
   if(!offscreen||!activeFrame)throw new Error('Missing preview or active frame: '+JSON.stringify(heard));
   if(offscreen.type!=='sidebar-preview'||activeFrame.type!=='message-delta')throw new Error('Wrong projection mode');
   results.push({platform:'release-android',profile:profile.name,trial,offscreenBytes:offscreen.bytes,activeBytes:activeFrame.bytes,arrivalMs:activeFrame.atMs-clock.deviceMinusHostMs-actionAt,offscreenType:offscreen.type,actionAt,activeFrame,offscreen});
   console.log(JSON.stringify(results.at(-1)));
   await writeFile('/tmp/jellybean-hol-android-results.json',JSON.stringify({reproduction:'NET-HOL-1',clock,results},null,2));
  }
 }
 adb('shell','uiautomator','dump','/sdcard/hol-visible.xml');
 const xml=adb('shell','cat','/sdcard/hol-visible.xml');
 const lastText='Incoming fixture '+results.at(-1).activeFrame.id.slice(0,16);
 const visibleLastMessage=xml.includes(lastText);
 await writeFile('/tmp/jellybean-hol-android-results.json',JSON.stringify({reproduction:'NET-HOL-1',clock,results,visibleLastMessage},null,2));
 if(!visibleLastMessage)throw new Error('Latest active message is not visible');
}finally{await stimulus.close();await db.end();}
