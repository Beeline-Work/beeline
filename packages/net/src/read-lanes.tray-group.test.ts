import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SavedRow, SavedWindow } from '@beeline/api-contract/router-protocol';
import { ReadLanes, type LaneBatch, type LaneFact, type LaneRequest, type LaneSnapshot } from './private/read-lanes.js';
import { validateSavedWindow } from './private/saved-windows.js';
import { validateTrayProjection } from './private/owner-inputs.js';

const ws='11111111-1111-4111-8111-111111111111',room='22222222-2222-4222-8222-222222222222';
const identity={origin:'https://synthetic.test',principal:'ada',sessionEpoch:1};
const count={family:'needs-you-count',workspaceId:ws} as const,head={family:'needs-you-tray',workspaceId:ws} as const;
const cursor='saved1.cGFnZQ',page={family:'needs-you-saved-page',workspaceId:ws,before:cursor} as const;
const group=`needs-you:${ws}:ada`,reader=`reader:ada:workspace:${ws}`,visibility=`${reader}:visibility`;
const authority={digest:'current-certificate',scopes:[{authorityScope:reader,epoch:'1'},{authorityScope:visibility,epoch:'1'}]};
const cv=(revision=0)=>`tray-clock-v1:${'a'.repeat(32)}:${revision}`;
const cut=(through:number)=>({stream:`workspace:${ws}`,epoch:'retained',through,protocol:1 as const});
const need={messageId:'question',workspaceId:ws,roomId:room,roomName:'Room',roomKind:'room',text:'Please?',createdAt:1} as const;
const row=(n:number,text=`Saved ${n}`):SavedRow=>({bookmarkId:`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,
  order:`${10000000-n},m-${n}`,before:`saved1.cm93${n}`,value:{messageId:`m-${n}`,workspaceId:ws,roomId:room,
    roomName:'Room',roomKind:'room',messageCreatedAt:1,bookmarkedAt:9,available:true,text}});
const window=(rows:readonly SavedRow[],before?:string):SavedWindow=>({windowId:`saved1:${(before?'b':'c').repeat(64)}`,
  ...(before?{before}:{}),rows,next:'saved1.bmV4dA'});
const headValue=()=>({needs:{items:[need]},saved:window([row(1)])});
const value=(request:LaneRequest)=>request.family==='needs-you-count'?{count:1}:request.family==='needs-you-tray'?headValue():window([row(2),row(3)],cursor);
const snapshot=(request:LaneRequest,through=1,clockVersion=cv(),data=value(request)):LaneSnapshot=>({kind:'snapshot',value:data,cut:cut(through),atomicGroup:group,authority,clockVersion});
const fact=(payload:LaneFact['payload']):LaneFact=>({atomicGroup:group,authority,payload});
const batch=(from:number,to:number,facts:readonly LaneFact[]=[],version=cv()):LaneBatch=>{
  const records=[...facts,fact({kind:'tray-classification',scope:ws,version:1,clockVersion:version})];
  return{from:cut(from),to:cut(to),facts:records,contentDigest:createHash('sha256').update(JSON.stringify(records)).digest('hex')};
};
const permit={isCurrent:()=>true};
const settle=async()=>{for(let i=0;i<140;i++)await Promise.resolve();};
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};};
function valid(request:LaneRequest,data:unknown){
  if(request.family==='needs-you-saved-page')return validateSavedWindow(data,ws);
  if(request.family==='needs-you-tray')return validateTrayProjection(data,ws);
  return typeof(data as {count?:unknown})?.count==='number';
}
async function setup(execute:(request:LaneRequest)=>Promise<LaneSnapshot>=async request=>snapshot(request),write?:(_key:string,encoded:string)=>Promise<void>){
  let reads=0;const writes:string[]=[];
  const lanes=new ReadLanes(identity,valid,{write:async(key,encoded)=>{writes.push(encoded);await write?.(key,encoded);},fence:async()=>{},floor:async()=>{},remove:async()=>{}});
  lanes.connected(1,['needs-you-count','needs-you-tray','needs-you-saved-page'],async request=>{reads++;return execute(request);});
  lanes.demand(count,{},permit);lanes.demand(head,{},permit);await settle();return{lanes,writes,reads:()=>reads};
}
const edits=()=>[fact({kind:'scope-replace',family:'needs-you-count',scope:ws,value:{count:0}}),
  fact({kind:'tray-needs-replace',scope:ws,value:{items:[]}}),fact({kind:'saved-row-replace',scope:ws,row:row(1,'Edited head')}),
  fact({kind:'saved-row-remove',scope:ws,bookmarkId:row(3).bookmarkId,messageId:row(3).value.messageId})];

describe('Saved selected whole Needs/Tray/window group assembly',()=>{
  it('a failed Tray re-read parks only that item and retains the healthy count',async()=>{
    let failing=false;
    const{lanes,reads}=await setup(async request=>{
      if(failing&&request.family==='needs-you-tray')throw new Error('unavailable');
      return snapshot(request);
    });
    failing=true;lanes.unavailable(`workspace:${ws}`,'needs-you-tray');await settle();
    expect(lanes.peek(head)).toMatchObject({state:'PARKED',error:'This item could not be loaded; Retry.'});
    expect(lanes.peek(count)).toMatchObject({state:'LIVE',value:{count:1},error:null});
    expect(reads()).toBe(3);
  });

  it('persists all retained members at one cut and publishes all values before any observer runs',async()=>{
    const{lanes,writes,reads}=await setup();lanes.demand(page,{},permit);await settle();
    const seen:number[][]=[];for(const request of[count,head,page])lanes.subscribe(request,()=>seen.push([count,head,page].map(key=>lanes.peek(key).cut?.through??-1)));
    const before=writes.length;await lanes.accept(batch(1,2,edits(),cv(1)));
    expect(writes.length-before).toBe(1);expect(seen).toEqual([[2,2,2],[2,2,2],[2,2,2]]);
    expect(lanes.peek(count).value).toEqual({count:0});expect(lanes.peek(head).value).toMatchObject({needs:{items:[]},saved:{rows:[{value:{text:'Edited head'}}]}});
    expect((lanes.peek(page).value as SavedWindow).rows.map(entry=>entry.value.messageId)).toEqual(['m-2']);
    const envelope=JSON.parse(writes.at(-1)!);expect(envelope.entries).toHaveLength(3);
    expect(envelope.entries.every((entry:{snapshot:LaneSnapshot})=>entry.snapshot.cut.through===2&&entry.snapshot.clockVersion===cv(1))).toBe(true);expect(reads()).toBe(3);
  });

  it('applies 100 canonical head arrivals without reopening or refilling held history',async()=>{
    const{lanes,reads}=await setup();lanes.demand(page,{},permit);await settle();
    const held=lanes.peek(page).value;
    for(let n=0;n<100;n++){
      const saved=window(Array.from({length:30},(_,i)=>row(100+n*30+i)));
      await lanes.accept(batch(n+1,n+2,[fact({kind:'scope-replace',family:'needs-you-saved-page',scope:ws,value:saved})]));
      expect(lanes.peek(head).value).toMatchObject({saved});
      expect(lanes.peek(page).value).toEqual(held);
      expect([count,head,page].map(request=>lanes.peek(request).cut?.through)).toEqual([n+2,n+2,n+2]);
    }
    expect(reads()).toBe(3);
  });

  it.each(['missing','query','oversize','row'] as const)('re-reads a malformed %s head interval without painting its data',async kind=>{
    const{lanes,reads}=await setup();lanes.demand(page,{},permit);await settle();
    const saved=kind==='missing'?undefined:kind==='query'?{...window([row(1)]),windowId:`saved1:${'f'.repeat(64)}`}:
      kind==='oversize'?window(Array.from({length:31},(_,i)=>row(i+1))):window([row(1)]);
    const facts=[fact({kind:'scope-replace',family:'needs-you-saved-page',scope:ws,value:saved})];
    if(kind==='row')facts.push(fact({kind:'saved-row-replace',scope:ws,row:{...row(99),value:{...row(99).value,workspaceId:room}}}));
    await lanes.accept(batch(1,2,facts));
    for(const request of[count,head,page])expect(lanes.peek(request).value).toBeNull();
    await settle();
    for(const request of[count,head,page])expect(lanes.peek(request)).toMatchObject({state:'LIVE',value:value(request)});
    expect(reads()).toBe(6);
  });

  it('replays complete intervals over an older opening page before it can paint and preserves the sealed cursor/hole',async()=>{
    const response=deferred<LaneSnapshot>();const{lanes,reads}=await setup(async request=>request.family==='needs-you-saved-page'?response.promise:snapshot(request));
    lanes.demand(page,{},permit);await settle();await lanes.accept(batch(1,2,edits(),cv(1)));
    expect(lanes.peek(page).value).toBeNull();response.resolve(snapshot(page));await settle();
    expect(lanes.peek(page)).toMatchObject({state:'LIVE',cut:{through:2},value:{before:cursor,next:'saved1.bmV4dA',rows:[{value:{messageId:'m-2'}}]}});expect(reads()).toBe(3);
  });

  it('waits for held head/count to catch up to an ahead page instead of mixing C and N or issuing a read',async()=>{
    const{lanes,reads,writes}=await setup(async request=>snapshot(request,request.family==='needs-you-saved-page'?2:1,request.family==='needs-you-saved-page'?cv(1):cv()));
    const before=writes.length;lanes.demand(page,{},permit);await settle();expect(lanes.peek(page).value).toBeNull();expect(writes).toHaveLength(before);
    await lanes.accept(batch(1,2,edits(),cv(1)));expect([count,head,page].map(request=>lanes.peek(request).cut?.through)).toEqual([2,2,2]);expect(reads()).toBe(3);
  });

  it('accepts a complete interval overlapping its snapshot cut and never requires a fabricated exact boundary',async()=>{
    const{lanes}=await setup();lanes.demand(page,{},permit);await settle();await lanes.accept(batch(0,2,edits(),cv(1)));
    expect([count,head,page].map(request=>lanes.peek(request).cut?.through)).toEqual([2,2,2]);
  });

  it('classifies a true no-op only in volatile memory with zero storage/UI work, then joins a current page coherently',async()=>{
    const{lanes,writes}=await setup(async request=>snapshot(request,request.family==='needs-you-saved-page'?2:1));
    let publishes=0;lanes.subscribe(head,()=>publishes++);const before=writes.length;
    await lanes.accept(batch(1,2));expect(writes).toHaveLength(before);expect(publishes).toBe(0);expect(lanes.peek(head).cut?.through).toBe(1);
    lanes.demand(page,{},permit);await settle();expect([count,head,page].map(request=>lanes.peek(request).cut?.through)).toEqual([2,2,2]);
  });

  it('ignores unheld insertions and never fills a deleted historical row or mutates next/before/order',async()=>{
    const{lanes,reads}=await setup();lanes.demand(page,{},permit);await settle();const old=lanes.peek(page).value as SavedWindow;
    await lanes.accept(batch(1,2,[fact({kind:'saved-row-replace',scope:ws,row:row(99)}),
      fact({kind:'saved-row-remove',scope:ws,bookmarkId:row(2).bookmarkId,messageId:row(2).value.messageId})]));
    const current=lanes.peek(page).value as SavedWindow;expect(current.rows.map(entry=>entry.bookmarkId)).toEqual([row(3).bookmarkId]);
    expect(current.before).toBe(old.before);expect(current.next).toBe(old.next);expect(current.windowId).toBe(old.windowId);expect(current.rows[0]!.order).toBe(old.rows[1]!.order);expect(reads()).toBe(3);
  });

  it('parks only the page whose reply is older than its known opening prefix',async()=>{
    const{lanes,reads}=await setup(async request=>snapshot(request));await lanes.accept(batch(1,2));
    lanes.demand(page,{},permit);await settle();expect(lanes.peek(page)).toMatchObject({state:'PARKED',value:null});
    expect(lanes.peek(count).state).toBe('LIVE');expect(lanes.peek(head).state).toBe('LIVE');expect(reads()).toBe(3);
  });

  it('requires classification, exact current certificate and committed clock without reviving older data',async()=>{
    for(const kind of['missing','clock','scope','certificate']){
      const{lanes,reads}=await setup();const update=batch(1,2,edits(),cv(1));
      const facts=update.facts.map(entry=>entry.payload.kind!=='tray-classification'?entry:kind==='clock'?{...entry,payload:{...entry.payload,clockVersion:'wall-time'}}:
        kind==='scope'?{...entry,payload:{...entry.payload,scope:'wrong'}}:kind==='certificate'?{...entry,authority:{...authority,digest:'unrelated'}}:entry);
      await lanes.accept({...update,facts:kind==='missing'?facts.filter(entry=>entry.payload.kind!=='tray-classification'):facts});
      await settle();expect(lanes.peek(head)).toMatchObject({state:'LIVE',value:headValue()});expect(lanes.peek(count).value).toEqual({count:1});expect(reads()).toBe(4);
    }
  });

  it('rejects same-incarnation order changes, page scope replacements and full-head hole refills',async()=>{
    for(const kind of['metadata','page','head']){
      const{lanes,reads}=await setup();lanes.demand(page,{},permit);await settle();
      const payload:LaneFact['payload']=kind==='metadata'?{kind:'saved-row-replace',scope:ws,row:{...row(2),order:'7,m-2'}}:
        {kind:'scope-replace',scope:ws,family:kind==='page'?'needs-you-saved-page':'needs-you-tray',value:kind==='page'?window([row(98)],cursor):{...headValue(),saved:window([row(98)])}};
      await lanes.accept(batch(1,2,[fact(payload)]));await settle();expect(lanes.peek(head).value).toEqual(headValue());expect(lanes.peek(page).value).toEqual(value(page));expect(reads()).toBe(6);
    }
  });

  it('publishes the complete live group and preserves the old cached cut when cache persistence fails',async()=>{
    let fail=false;const{lanes,writes,reads}=await setup(undefined,async()=>{if(fail)throw new Error('storage');});
    const old=JSON.parse(writes.at(-1)!);fail=true;await lanes.accept(batch(1,2,edits(),cv(1)));
    expect(lanes.peek(head)).toMatchObject({state:'LIVE',cut:{through:2}});expect(lanes.peek(count)).toMatchObject({state:'LIVE',cut:{through:2}});
    expect(old.entries.every((entry:{snapshot:LaneSnapshot})=>entry.snapshot.cut.through===1)).toBe(true);expect(reads()).toBe(2);
  });

  it('fences a queued snapshot by durable authority even if its request completed before the floor write',async()=>{
    const response=deferred<LaneSnapshot>();const{lanes,reads}=await setup(async request=>request.family==='needs-you-saved-page'?response.promise:snapshot(request));
    lanes.demand(page,{},permit);await settle();await lanes.advance(visibility,'2');response.resolve(snapshot(page));await settle();
    expect(lanes.peek(page).value).toBeNull();expect(lanes.peek(head).value).toBeNull();expect(reads()).toBe(3);
  });

  it('serializes all source ingress during slow persistence without parking a valid group',async()=>{
    const gate=deferred<void>(),entered=deferred<void>();let block=false;
    const{lanes,reads}=await setup(undefined,async()=>{if(block){entered.resolve();await gate.promise;}});block=true;
    const active=lanes.accept(batch(1,2,edits(),cv(1)));await entered.promise;
    const future:Promise<void>[]=[];for(let n=2;n<21;n++)future.push(lanes.accept(batch(n,n+1,[],cv(1))));
    expect(lanes.peek(head).state).toBe('LIVE');gate.resolve();await active;await Promise.all(future);expect(reads()).toBe(2);
    expect(lanes.peek(head)).toMatchObject({state:'LIVE',error:null});
  });

  it('an old generation storage completion cannot publish or park the fresh connection',async()=>{
    const gate=deferred<void>(),entered=deferred<void>();let block=false;
    const{lanes}=await setup(undefined,async()=>{if(block){entered.resolve();await gate.promise;}});block=true;
    const active=lanes.accept(batch(1,2,edits(),cv(1)));await entered.promise;block=false;
    lanes.disconnected();lanes.connected(2,['needs-you-count','needs-you-tray','needs-you-saved-page'],async request=>snapshot(request,10));
    gate.resolve();await active;await settle();expect(lanes.peek(count)).toMatchObject({state:'LIVE',cut:{through:10}});expect(lanes.peek(head)).toMatchObject({state:'LIVE',cut:{through:10}});
  });

  it('does not start a second page read when same-key owners join or when a source update arrives',async()=>{
    const{lanes,reads}=await setup();const token={};lanes.demand(page,token,permit);lanes.demand({...page},token,permit);await settle();
    await lanes.accept(batch(1,2,[fact({kind:'saved-row-replace',scope:ws,row:row(2,'Source edit')})]));expect(reads()).toBe(3);
    expect(lanes.peek(page)).toMatchObject({state:'LIVE',cut:{through:2}});
  });

  it('replays an opening Room subset without reclassifying the already committed Tray interval',async()=>{
    const response=deferred<LaneSnapshot>(),roomRequest={family:'room-head',roomId:room,workspaceId:ws} as const;
    const roomAuthority={digest:'room-certificate',scopes:[{authorityScope:reader,epoch:'1'},{authorityScope:`room:${room}`,epoch:'1'}]};
    const roomGroup=`room-head:${room}:ada`;let reads=0;
    const lanes=new ReadLanes(identity,(request,data)=>request.family==='room-head'?typeof data==='string':valid(request,data));
    lanes.connected(1,['room-head','needs-you-count','needs-you-tray','needs-you-saved-page'],async request=>{
      reads++;return request.family==='room-head'?response.promise:snapshot(request);
    });
    lanes.demand(count,{},permit);lanes.demand(head,{},permit);await settle();lanes.demand(roomRequest,{},permit);await settle();
    await lanes.accept(batch(1,2,[...edits(),{atomicGroup:roomGroup,authority:roomAuthority,
      payload:{kind:'scope-replace',family:'room-head',scope:room,value:'Updated Room'}}],cv(1)));
    response.resolve({kind:'snapshot',atomicGroup:roomGroup,authority:roomAuthority,cut:cut(1),value:'Initial Room'});await settle();
    expect(lanes.peek(roomRequest)).toMatchObject({state:'LIVE',value:'Updated Room',cut:{through:2}});
    expect(lanes.peek(head)).toMatchObject({state:'LIVE',cut:{through:2}});expect(lanes.peek(count).value).toEqual({count:0});expect(reads).toBe(3);
  });

  it('automatic data recovery holds an opening group until its reply can replay later updates',async()=>{
    const response=deferred<void>();let recovering=false;
    const{lanes,reads}=await setup(async request=>{
      if(recovering){await response.promise;return snapshot(request,2,cv(1));}
      return snapshot(request);
    });
    recovering=true;
    await lanes.accept({...batch(1,2),facts:[]});await settle();
    expect(lanes.peek(head).value).toBeNull();
    await lanes.accept(batch(2,3,edits(),cv(2)));
    response.resolve();await settle();
    expect(lanes.peek(head)).toMatchObject({state:'LIVE',cut:{through:3},value:{needs:{items:[]}}});
    expect(lanes.peek(count).value).toEqual({count:0});expect(reads()).toBe(4);
  });

  it('a Tray cache failure still publishes the complete Tray and independent Room interval',async()=>{
    const roomRequest={family:'room-head',roomId:room,workspaceId:ws} as const;
    const roomAuthority={digest:'room-certificate',scopes:[{authorityScope:reader,epoch:'1'},{authorityScope:`room:${room}`,epoch:'1'}]},roomGroup=`room-head:${room}:ada`;
    let fail=false,reads=0;
    const lanes=new ReadLanes(identity,(request,data)=>request.family==='room-head'?typeof data==='string':valid(request,data),{
      write:async(key)=>{if(fail&&JSON.parse(key)[2]===group)throw new Error('synthetic Tray storage failure');},
      fence:async()=>{},floor:async()=>{},remove:async()=>{},
    });
    lanes.connected(1,['room-head','needs-you-count','needs-you-tray','needs-you-saved-page'],async request=>{
      reads++;return request.family==='room-head'?{kind:'snapshot',value:'Room before',cut:cut(1),atomicGroup:roomGroup,authority:roomAuthority}:snapshot(request);
    });
    for(const request of[count,head,roomRequest])lanes.demand(request,{},permit);await settle();fail=true;
    await lanes.accept(batch(1,2,[...edits(),{atomicGroup:roomGroup,authority:roomAuthority,
      payload:{kind:'scope-replace',family:'room-head',scope:room,value:'Room after'}}],cv(1)));
    expect(lanes.peek(head)).toMatchObject({state:'LIVE',cut:{through:2}});expect(lanes.peek(count)).toMatchObject({state:'LIVE',cut:{through:2}});
    expect(lanes.peek(roomRequest)).toMatchObject({state:'LIVE',value:'Room after',cut:{through:2}});expect(reads).toBe(3);
  });
});
