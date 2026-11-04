import { describe, expect, it } from 'vitest';
import { LaneStaging } from './private/lane-staging.js';
import type { LaneBatch, LaneFact } from './private/read-lanes.js';

const authority={digest:'certificate',scopes:[{authorityScope:'room:a',epoch:'1'}]};
const fact=(text:string):LaneFact=>({atomicGroup:'room:a',authority,payload:{kind:'scope-replace',family:'room-head',scope:'a',value:text}});
const interval=(n:number,facts:readonly LaneFact[]):LaneBatch=>({from:{stream:'workspace:w',epoch:'e',through:n,protocol:1},
  to:{stream:'workspace:w',epoch:'e',through:n+1,protocol:1},facts});

describe('shared retained lane intervals',()=>{
  it('charges a complete source body once across opening lanes and sealed windows',()=>{
    const store=new LaneStaging(),opening=store.stage(),window=store.stage();
    const first=fact('x'.repeat(700*1024)),second=fact('second'),body=interval(1,[first,second]);
    opening.add(body,[first]);window.add(body,[second]);
    expect([...opening.values()][0]!.batch.facts[0]).toBe(first);
    expect([...window.values()][0]!.batch.facts[0]).toBe(second);
    expect(()=>store.stage().add(interval(2,[fact('x'.repeat(200*1024))]))).not.toThrow();
    expect(()=>store.stage().add(interval(3,[fact('x'.repeat(100*1024))]))).not.toThrow();
  });
  it('retains large independent intervals for different consumers',()=>{
    const store=new LaneStaging();
    store.stage().add(interval(0,[fact('x'.repeat(200*1024))]));
    store.stage().add(interval(1,[fact('x'.repeat(200*1024))]));
    expect(()=>store.stage().add(interval(2,[fact('x'.repeat(200*1024))]))).not.toThrow();
  });
  it('releases only the retiring consumer, and releases the body after its last consumer',()=>{
    const store=new LaneStaging(),one=store.stage(),two=store.stage(),body=interval(0,[fact('x'.repeat(700*1024))]);
    one.add(body);two.add(body);one.clear();
    expect(two.size).toBe(1);expect(()=>store.stage().add(interval(1,[fact('x'.repeat(300*1024))]))).not.toThrow();
    two.clear();expect(()=>store.stage().add(interval(1,[fact('x'.repeat(700*1024))]))).not.toThrow();
  });
  it('releases unauthorized private references across every consumer while retaining content-free continuity',()=>{
    const store=new LaneStaging(),one=store.stage(),two=store.stage();
    const control:LaneFact={atomicGroup:'room:a',authority,payload:{kind:'authority',scope:'a',authorityScope:'room:a',allowed:false}};
    const body=interval(0,[fact('private'),control]);one.add(body);two.add(body,[body.facts[0]!]);
    store.prune(item=>item.payload.kind==='authority');
    expect([...one.values()][0]!.batch.facts).toEqual([control]);
    expect(two.take()).toEqual([{ ...body, facts: [] }]);
    expect(two.size).toBe(0);
  });
  it.each([false, true])('retains empty intervals and classification across repeated pruning (future=%s)', future => {
    const store = new LaneStaging(), stage = store.stage(future);
    const empty = interval(0, []);
    const classified: LaneBatch = { ...interval(1, [fact('private')]), scheduledWorkClassification: {
      kind: 'scheduled-work-classification', version: 1,
      authorityBarrier: { stream: 'authority:p', epoch: 'a', segment: 's', through: 2, protocol: 1 },
    } };
    stage.add(empty); stage.add(classified);
    store.prune(() => false); store.prune(() => false);
    expect(stage.take()).toEqual([empty, { ...classified, facts: [] }]);
    expect(stage.size).toBe(0);
  });
  it.each([false, true])('keeps original byte charges after pruning private payloads (future=%s)', future => {
    const store = new LaneStaging(), stage = store.stage(future);
    const body = interval(0, [fact('x'.repeat(200 * 1024))]);
    stage.add(body);
    const bytes = [...stage.values()][0]!.bytes;
    store.prune(() => false);
    expect([...stage.values()][0]).toEqual({ batch: { ...body, facts: [] }, bytes });
    if (!future) stage.add(interval(1, [fact('x'.repeat(200 * 1024))]));
    expect(() => stage.add(interval(2, [fact('x'.repeat(100 * 1024))]))).toThrow('overflow');
    stage.clear();
    expect(() => stage.add(interval(3, [fact('x'.repeat(200 * 1024))]))).not.toThrow();
  });
  it.each([false, true])('keeps count limits after pruning every payload (future=%s)', future => {
    const store = new LaneStaging(), stage = store.stage(future);
    const limit = future ? 16 : 17;
    for (let i = 0; i < limit; i++) stage.add(interval(i, [fact('private')]));
    store.prune(() => false);
    expect(stage.size).toBe(limit);
    expect([...stage.values()].every(value => value.batch.facts.length === 0)).toBe(true);
    expect(() => stage.add(interval(limit, []))).toThrow('overflow');
    expect(stage.take()).toHaveLength(limit);
    expect(() => stage.add(interval(limit, []))).not.toThrow();
  });
  it('retains future intervals and deduplicates same-consumer references',()=>{
    const store=new LaneStaging(),future=store.stage(true),body=interval(0,[fact('small')]);
    future.add(body);future.add(body);expect(future.size).toBe(1);
    for(let i=1;i<16;i++)future.add(interval(i,[fact('small')]));
    expect(()=>future.add(interval(16,[fact('small')]))).not.toThrow();
    expect(future.take()).toHaveLength(17);expect(future.size).toBe(0);
  });
  it('rejects a changed same-consumer body without replacing its already verified facts',()=>{
    const store=new LaneStaging(),stage=store.stage(),body=interval(0,[fact('original')]);stage.add(body);
    expect(()=>stage.add(interval(0,[fact('conflict')]))).toThrow('Conflicting');
    expect([...stage.values()][0]!.batch.facts).toEqual(body.facts);
  });
  it('allows independent same-cut classification and data deliveries without sharing their byte charge',()=>{
    const store=new LaneStaging(),scheduled=store.stage(true),count=store.stage(true);
    const body=interval(2,[fact('count')]);
    const control:LaneBatch={...body,facts:[],scheduledWorkClassification:{kind:'scheduled-work-classification',version:1,
      authorityBarrier:{stream:'authority:p',epoch:'a',segment:'s',through:3,protocol:1}}};
    scheduled.add(control);expect(()=>count.add(body)).not.toThrow();
    expect([...scheduled.values()][0]!.batch.scheduledWorkClassification).toBe(control.scheduledWorkClassification);
    expect([...count.values()][0]!.batch.facts).toEqual(body.facts);
    scheduled.clear();count.clear();
    const large=interval(4,[fact('x'.repeat(400*1024))]);
    // Equal cuts are not a proof that two separately owned bodies are equal.
    const one=store.stage(),two=store.stage();one.add(large);
    expect(()=>two.add({...large,facts:[fact('y'.repeat(400*1024))]})).not.toThrow();
  });
  it('keeps source arrival order when the oldest consumer releases and treats a released body reattachment as new',()=>{
    const store=new LaneStaging(),first=store.stage(),later=store.stage(),joined=store.stage();
    const primary=interval(0,[fact('x'.repeat(700*1024))]);
    first.add(primary);later.add(interval(1,[fact('x'.repeat(100*1024))]));joined.add(primary);first.clear();
    // Live consumer iteration now starts with the later100KiB source. It must
    // not turn the still-held700KiB primary into an oversized future body.
    const last=store.stage();expect(()=>last.add(interval(2,[fact('x'.repeat(50*1024))]))).not.toThrow();
    joined.clear();expect(()=>joined.add(primary)).not.toThrow();
  });
});
