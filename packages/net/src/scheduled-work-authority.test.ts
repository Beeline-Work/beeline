import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ScheduledWorkAuthorityFrame, ScheduledWorkAuthorityPosition } from '@beeline/api-contract/router-protocol';
import { ScheduledWorkAuthority, type ScheduledAuthorityFence } from './private/scheduled-work-authority.js';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const principal='viewer';
const at=(through:number,segment='segment',epoch='retained'):ScheduledWorkAuthorityPosition=>({stream:`authority:${principal}`,epoch,segment,through,protocol:1});
const fence=(scope='room-b',mode:'deny'|'advance'='advance',epoch='2'):ScheduledAuthorityFence=>{
  const authorityScope=`scheduled-work-room:${scope}`,scopes=[{authorityScope,epoch}];
  return{kind:'authority-fence',scope,authorityScope,mode,authority:{digest:hash(scopes),scopes}};
};
function frames(from:number,to:number,parts:readonly (readonly ScheduledAuthorityFence[])[]=[[]],id=`batch-${from}-${to}`):ScheduledWorkAuthorityFrame[]{
  const common={batchId:id,from:at(from),to:at(to),partCount:parts.length,contentDigest:hash(parts.flat())};
  return [...parts.map((fences,partIndex)=>({kind:'scheduled-work-authority-part' as const,...common,partIndex,fences})),
    {kind:'scheduled-work-authority-commit' as const,...common}];
}
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};};
function rig(persist=(value:ScheduledAuthorityFence):Promise<void>=>Promise.resolve()){
  const stored=vi.fn(persist),park=vi.fn(),actor=new ScheduledWorkAuthority(principal,{digest:hash,persist:stored,park});
  expect(actor.connected(1,at(0))).toBe(true);
  return{actor,stored,park};
}
async function deliver(actor:ScheduledWorkAuthority,values:readonly ScheduledWorkAuthorityFrame[],generation=1){for(const value of values)await actor.accept(generation,value);}
function stage(actor:ScheduledWorkAuthority,through:number,id=`snapshot-${through}`,size=100,kind:'snapshot'|'batch'='snapshot'){
  const apply=vi.fn(),discard=vi.fn();actor.defer(1,{id,kind,barrier:at(through),bytes:size,apply,discard});return{apply,discard};
}

describe('Scheduled Work bounded local authority/barrier actor',()=>{
  it('requires digest-verified complete parts+commit and all durable floors before releasing snapshot or batch',async()=>{
    const gate=deferred(),entered=deferred();const {actor,stored,park}=rig(async()=>{entered.resolve();await gate.promise;});
    const snapshot=stage(actor,10),batch=stage(actor,10,'workspace-batch',200,'batch');
    const [part,commit]=frames(0,10,[[fence()]]);
    await actor.accept(1,commit);expect(stored).not.toHaveBeenCalled();expect(snapshot.apply).not.toHaveBeenCalled();
    const processing=actor.accept(1,part);await entered.promise;
    expect(actor.position()).toEqual(at(0));expect(snapshot.apply).not.toHaveBeenCalled();expect(batch.apply).not.toHaveBeenCalled();
    gate.resolve();await processing;
    expect(stored).toHaveBeenCalledTimes(1);expect(snapshot.apply).toHaveBeenCalledOnce();expect(batch.apply).toHaveBeenCalledOnce();
    expect(actor.position()).toEqual(at(10));expect(park).not.toHaveBeenCalled();
  });

  it('orders reordered retained intervals and never treats a missing authority interval as processed',async()=>{
    const {actor,stored}=rig(),held=stage(actor,20);
    await deliver(actor,frames(10,20,[[fence('later','deny','3')]]));
    expect(actor.position()).toEqual(at(0));expect(stored).not.toHaveBeenCalled();expect(held.apply).not.toHaveBeenCalled();
    await deliver(actor,frames(0,10,[[fence('earlier')]]));
    expect(stored.mock.calls.map(([value])=>value.scope)).toEqual(['earlier','later']);expect(actor.position()).toEqual(at(20));
    expect(held.apply).toHaveBeenCalledOnce();
  });

  it('verifies reordered multipart content and canonical sorted certificate digest before persisting',async()=>{
    const {actor,stored}=rig(),one=fence('a'),two=fence('b','deny');
    const scopes=[{authorityScope:'scheduled-work-room:z',epoch:'4'},{authorityScope:'scheduled-work-room:a',epoch:'2'}];
    const full={...one,authority:{digest:hash([...scopes].sort((a,b)=>a.authorityScope.localeCompare(b.authorityScope))),scopes}};
    const [first,second,commit]=frames(0,4,[[full],[two]]);
    await deliver(actor,[commit!,second!,first!]);
    expect(actor.position()).toEqual(at(4));expect(stored.mock.calls.map(([value])=>value.scope)).toEqual(['a','b']);
  });

  it('rejects invalid content or certificate hashes without persisting any control',async()=>{
    for(const corrupt of['content','certificate']){
      const {actor,stored,park}=rig(),control=fence();
      const broken=corrupt==='certificate'?{...control,authority:{...control.authority,digest:'f'.repeat(64)}}:control;
      const values=frames(0,10,[[broken]]).map(frame=>corrupt==='content'&&frame.kind!=='scheduled-work-authority-restart'?{...frame,contentDigest:'f'.repeat(64)}:frame);
      await deliver(actor,values);expect(stored).not.toHaveBeenCalled();expect(actor.position()).toBeUndefined();expect(park).toHaveBeenCalledWith('digest');
    }
  });

  it('rejects mismatched principal/domain/logical scope and unknown physical fields before any persist',async()=>{
    for(const change of['principal','scope','mode','field','domain']){
      const {actor,stored,park}=rig();const [part]=frames(0,1,[[fence()]]);if(part!.kind!=='scheduled-work-authority-part')throw new Error('fixture');
      const value:Record<string,unknown>=JSON.parse(JSON.stringify(part));
      if(change==='principal')value.to={...part.to,stream:'authority:someone-else'};
      else if(change==='field')value.inventory=[];
      else {const control={...fence()};if(change==='scope')control.scope='wrong';
        if(change==='mode')delete (control as {mode?:string}).mode;
        if(change==='domain'){control.authorityScope='room:room-b';control.authority={digest:hash([{authorityScope:'room:room-b',epoch:'2'}]),scopes:[{authorityScope:'room:room-b',epoch:'2'}]};}
        value.fences=[control];}
      await actor.accept(1,value);expect(stored).not.toHaveBeenCalled();expect(park).toHaveBeenCalledOnce();expect(actor.position()).toBeUndefined();
    }
  });

  it('joins duplicate physical frames with zero repeat storage and detects a conflicting replay part',async()=>{
    const {actor,stored,park}=rig(),values=frames(0,10,[[fence()]]);
    await deliver(actor,[values[0]!,values[0]!,values[1]!]);await deliver(actor,values);
    expect(stored).toHaveBeenCalledOnce();expect(park).not.toHaveBeenCalled();
    const original=values[0]!;if(original.kind!=='scheduled-work-authority-part')throw new Error('fixture');
    await actor.accept(1,{...original,fences:[fence('room-b','advance','3')]});
    expect(park).toHaveBeenCalledWith('digest');expect(actor.position()).toBeUndefined();expect(stored).toHaveBeenCalledOnce();
  });

  it('accepts same verified interval under a new batch id but refuses unknown overlapping history',async()=>{
    const {actor,stored,park}=rig();await deliver(actor,frames(0,10,[[fence()]]));
    await deliver(actor,frames(0,10,[[fence()]],'same-complete-interval'));
    expect(stored).toHaveBeenCalledOnce();expect(park).not.toHaveBeenCalled();
    await deliver(actor,frames(5,12,[[]],'overlap'));expect(park).toHaveBeenCalledWith('continuity');
  });

  it('keeps empty intervals content-free and a start only covers its own segment from its starting position',async()=>{
    const {actor,stored,park}=rig();await deliver(actor,frames(0,0));await deliver(actor,frames(0,10));
    expect(stored).not.toHaveBeenCalled();expect(actor.position()).toEqual(at(10));expect(park).not.toHaveBeenCalled();
    expect(stage(actor,7).apply).toHaveBeenCalledOnce();
    const fresh=rig();expect(fresh.actor.connected(2,at(50,'next'))).toBe(true);
    const apply=vi.fn(),discard=vi.fn();fresh.actor.defer(2,{id:'old-snapshot',kind:'snapshot',barrier:at(49,'next'),bytes:1,apply,discard});
    expect(apply).not.toHaveBeenCalled();expect(discard).toHaveBeenCalledWith('continuity');
  });

  it('fails closed on storage failure after partial persistence, never acknowledging or releasing the barrier',async()=>{
    const {actor,stored,park}=rig(async value=>{if(value.scope==='b')throw new Error('synthetic storage unavailable');});
    const pending=stage(actor,10);await deliver(actor,frames(0,10,[[fence('a'),fence('b')]]));
    expect(stored).toHaveBeenCalledTimes(2);expect(park).toHaveBeenCalledWith('storage');expect(actor.position()).toBeUndefined();
    expect(pending.apply).not.toHaveBeenCalled();expect(pending.discard).toHaveBeenCalledWith('storage');
    await deliver(actor,frames(0,10));expect(stored).toHaveBeenCalledTimes(2);
  });

  it('requires explicit source loss before restart, parks old data without reads, and starts an independent new segment',async()=>{
    const {actor,park,stored}=rig(),old=stage(actor,20);await deliver(actor,frames(0,10));
    actor.sourceLost(1);expect(park).toHaveBeenCalledWith('source-loss');expect(old.discard).toHaveBeenCalledWith('source-loss');
    await actor.accept(1,{kind:'scheduled-work-authority-restart',start:at(30,'recovered')});
    expect(park).toHaveBeenCalledWith('restart');expect(actor.position()).toEqual(at(30,'recovered'));expect(stored).not.toHaveBeenCalled();
    const fresh=rig();await fresh.actor.accept(1,{kind:'scheduled-work-authority-restart',start:at(0,'unannounced')});
    expect(fresh.park).toHaveBeenCalledWith('continuity');expect(fresh.actor.position()).toBeUndefined();
  });

  it('ignores stale generations and an old in-flight persist completion cannot release or park the new connection',async()=>{
    const entered=deferred(),gate=deferred();const {actor,park}=rig(async()=>{entered.resolve();await gate.promise;});
    const old=stage(actor,10),values=frames(0,10,[[fence()]]);await actor.accept(1,values[0]);
    const flight=actor.accept(1,values[1]);await entered.promise;
    actor.disconnected(1);expect(actor.connected(2,at(100,'new'))).toBe(true);
    const before=park.mock.calls.length;gate.resolve();await flight;
    expect(old.apply).not.toHaveBeenCalled();expect(actor.position()).toEqual(at(100,'new'));
    await actor.accept(1,{kind:'bad'});actor.sourceLost(1);actor.disconnected(1);
    expect(park.mock.calls).toHaveLength(before);expect(actor.connected(2,at(0))).toBe(false);
  });

  it('owns wire references across asynchronous persistence and cannot be changed by the caller',async()=>{
    const entered=deferred(),gate=deferred();const {actor,stored}=rig(async()=>{entered.resolve();await gate.promise;});
    const values=frames(0,10,[[fence()]]);await actor.accept(1,values[0]);const complete=actor.accept(1,values[1]);await entered.promise;
    const first=values[0];if(first?.kind!=='scheduled-work-authority-part')throw new Error('fixture');
    (first.fences[0] as {scope:string}).scope='mutated';(first.to as {through:number}).through=900;
    gate.resolve();await complete;expect(actor.position()).toEqual(at(10));expect(stored.mock.calls[0]![0].scope).toBe('room-b');
  });

  it('retains a primary authority batch larger than 256KiB including large future and physical parts',async()=>{
    const huge=fence('r'.repeat(120));
    const scopes=Array.from({length:8},(_,i)=>({authorityScope:`scheduled-work-room:${i===0?'r'.repeat(120):String(i)+'s'.repeat(119)}`,epoch:'2'}));
    const large={...huge,authority:{digest:hash([...scopes].sort((a,b)=>a.authorityScope.localeCompare(b.authorityScope))),scopes}};
    const part:ScheduledAuthorityFence[]=[];while(Buffer.byteLength(JSON.stringify([...part,large]))<=60*1024)part.push(large);
    const parts=Array.from({length:5},()=>part);expect(Buffer.byteLength(JSON.stringify(parts.flat()))).toBeGreaterThan(256*1024);
    const {actor,stored,park}=rig();await deliver(actor,frames(0,1,parts));expect(actor.position()).toEqual(at(1));expect(stored).toHaveBeenCalledOnce();expect(park).not.toHaveBeenCalled();
    const future=rig();await future.actor.accept(1,frames(0,1,[[fence()]],'primary')[0]);
    await deliver(future.actor,frames(1,2,parts,'too-large-future'));expect(future.park).not.toHaveBeenCalled();
    const physical=rig();await physical.actor.accept(1,frames(0,1,[[...part,...part]])[0]);expect(physical.park).not.toHaveBeenCalled();
  });

  it('retains queued snapshots and batches until their authority arrives',()=>{
    const {actor,park}=rig(),primary=stage(actor,10,'primary',1024*1024,'batch');
    for(let i=0;i<16;i++)stage(actor,11+i,`future-${i}`,16*1024);
    expect(park).not.toHaveBeenCalled();const overflow=stage(actor,50,'overflow',1);
    expect(park).not.toHaveBeenCalled();expect(primary.apply).not.toHaveBeenCalled();expect(overflow.apply).not.toHaveBeenCalled();
    expect(primary.discard).not.toHaveBeenCalled();
  });

  it('retains authority stages and persists more than 256 unique domains',async()=>{
    const {actor,park}=rig();for(let i=0;i<18;i++)await actor.accept(1,frames(i,i+1,[[]],`partial-${i}`)[0]);
    expect(park).not.toHaveBeenCalled();
    const domains=rig(),fences=Array.from({length:257},(_,index)=>fence(`room-${index}`));
    const parts=[];for(let i=0;i<fences.length;i+=32)parts.push(fences.slice(i,i+32));
    await deliver(domains.actor,frames(0,1,parts));expect(domains.park).not.toHaveBeenCalled();expect(domains.stored).toHaveBeenCalledTimes(257);
  });

  it('settles a duplicate pending callback without growing the queue, and callbacks cannot lose a reentrant receive wake',async()=>{
    const {actor,stored}=rig(),first=stage(actor,10,'same'),duplicate=stage(actor,10,'same');
    expect(duplicate.discard).toHaveBeenCalledWith('duplicate');expect(first.discard).not.toHaveBeenCalled();
    const followup=frames(10,20,[[fence('later')]]);let nested:Promise<void>|undefined;
    actor.defer(1,{id:'reentrant',kind:'batch',barrier:at(10),bytes:1,discard:vi.fn(),apply:()=>{
      nested=deliver(actor,followup);
    }});
    await deliver(actor,frames(0,10,[[fence('first')]]));await nested;
    expect(first.apply).toHaveBeenCalledOnce();expect(actor.position()).toEqual(at(20));expect(stored).toHaveBeenCalledTimes(2);
  });
});
