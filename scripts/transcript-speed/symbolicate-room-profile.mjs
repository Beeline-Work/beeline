/** Attribute the separately profiled switch's slow frames to the matching map. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const require=createRequire(new URL('../../apps/mobile/package.json',import.meta.url));
const {SourceMapConsumer}=require('source-map');
const {createContext}=require('metro-symbolicate/private/Symbolication');
const dir=process.argv[2];
const mapPath='apps/mobile/android/app/build/generated/sourcemaps/react/release/index.android.bundle.map';
const bundlePath='apps/mobile/android/app/build/generated/assets/react/release/index.android.bundle';
const digest=b=>createHash('sha256').update(b).digest('hex');
const apk=process.env.TRANSCRIPT_APK;
if(!apk)throw new Error('Matching after APK required');
const bundle=execFileSync('unzip',['-p',apk,'assets/index.android.bundle'],{maxBuffer:64e6});
if(digest(bundle)!==digest(readFileSync(bundlePath)))throw new Error('Source-map build bytecode differs from APK');
const mapText=readFileSync(mapPath,'utf8');
const ctx=createContext(SourceMapConsumer,mapText,{nameSource:'function_names',inputLineStart:1,inputColumnStart:0,outputLineStart:1,outputColumnStart:0});
const trace=JSON.parse(readFileSync(`${dir}/profile.json`,'utf8'));
const frames=JSON.parse(readFileSync(`${dir}/profile-frames.json`,'utf8'));
const log=readFileSync(`${dir}/profile.log`,'utf8');
const marks=[...log.matchAll(/\[ROOM_OPEN\]\s*(\{.*\})/g)].map(x=>JSON.parse(x[1]));
const nav=marks.find(x=>x.phase==='nav-dispatch');
if(!nav)throw new Error('Profile switch navigation marker missing');
const residual=frames.endMs-frames.startMs-frames.jsFrameIntervalsMs.reduce((a,b)=>a+b,0);
let cursor=frames.startMs+residual/2;
const windows=[];
for(const duration of frames.jsFrameIntervalsMs){const start=cursor;cursor+=duration;if(cursor>=nav.t&&duration>=30&&duration<=160)windows.push({startMs:start,endMs:cursor,durationMs:duration});}
for(const f of Object.values(trace.stackFrames)){
 if(f.funcVirtAddr!=null&&f.offset!=null){
  const p=ctx.getOriginalPositionDetailsFor(1,Number(f.funcVirtAddr)+Number(f.offset));
  f.original={source:p.source,line:p.line,column:p.column,functionName:p.functionName};
 }
}
const counts=new Map(),own=new Map();
let selectedSamples=0,rootOnly=0;
for(const sample of trace.samples){
 const at=Number(sample.ts)/1000;
 if(!windows.some(w=>at>=w.startMs&&at<=w.endMs))continue;
 selectedSamples++;
 let id=String(sample.sf),stack=[];
 while(trace.stackFrames[id]){const f=trace.stackFrames[id];stack.push(f);id=String(f.parent);}
 if(stack.length===1)rootOnly++;
 const seen=new Set();
 for(const f of stack){
  const p=f.original;
  const label=p?.source?`${p.functionName||f.name} (${p.source}:${p.line})`:f.name;
  if(!seen.has(label)){counts.set(label,(counts.get(label)||0)+1);seen.add(label);}
 }
 const f=stack.find(f=>f.original?.source?.startsWith('/sources/'));
 if(f){const p=f.original;const label=`${p.functionName||f.name} (${p.source}:${p.line})`;own.set(label,(own.get(label)||0)+1);}
}
const ranked=m=>[...m.entries()].sort((a,b)=>b[1]-a[1]).map(([frame,samples])=>({frame,samples}));
const summary={bytecodeSha256:digest(bundle),sourceMapSha256:digest(mapText),nav,firstFrameAlignmentUncertaintyMs:residual,windows,selectedSamples,rootOnly,inclusiveStacks:ranked(counts),nearestProductStacks:ranked(own),
 note:'Separate profiled switch only; sampled stacks in 30–160ms rAF gaps, not invocation counts or additive CPU time. Map bytecode is verified equal to the installed after APK. rAF and Hermes monotonic timestamp ranges are retained.'};
writeFileSync(`${dir}/profile-symbolicated.json`,JSON.stringify(trace));
writeFileSync(`${dir}/profile-summary.json`,JSON.stringify(summary,null,2));
console.log(JSON.stringify({...summary,inclusiveStacks:summary.inclusiveStacks.slice(0,20),nearestProductStacks:summary.nearestProductStacks.slice(0,20)},null,2));
