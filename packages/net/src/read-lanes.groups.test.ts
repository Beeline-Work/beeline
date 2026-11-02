import { describe, expect, it } from 'vitest';
import { ReadLanes, type LaneAuthority, type LaneBatch, type LaneFact, type LaneRequest, type LaneSnapshot } from './private/read-lanes.js';

const identity={origin:'https://synthetic.test',principal:'ada',sessionEpoch:1};
const workspace='w',reader='reader:ada:workspace:w',visibility=`${reader}:visibility`;
const a={family:'room-head',workspaceId:workspace,roomId:'a'} as const;
const b={family:'room-head',workspaceId:workspace,roomId:'b'} as const;
const count={family:'needs-you-count',workspaceId:workspace} as const;
const tray={family:'needs-you',workspaceId:workspace} as const;
const cut=(through:number)=>({stream:'workspace:w',epoch:'stream',protocol:1 as const,through});
const group=(request:LaneRequest)=>request.family==='room-head'?`room-head:${request.roomId}:ada`:'needs-you:w:ada';
const cert=(domain:string,epoch='1',parent?:string):LaneAuthority=>({digest:`${domain}:${epoch}:${parent??''}`,
  scopes:[{authorityScope:reader,epoch:'1'},{authorityScope:domain,epoch},...(parent?[{authorityScope:`room:${parent}`,epoch:'1'}]:[])]});
const base=(request:LaneRequest):LaneSnapshot=>({kind:'snapshot',value:{name:request.roomId??request.family},cut:cut(1),
  atomicGroup:group(request),authority:cert(request.roomId?`room:${request.roomId}`:visibility)});
const replace=(request:LaneRequest,authority=base(request).authority,value:unknown={name:'new'}):LaneFact=>({
  atomicGroup:group(request),authority,payload:{kind:'scope-replace',family:request.family,scope:request.roomId??workspace,value}});
const control=(request:LaneRequest,domain:string,epoch:string,mode:'deny'|'advance'='advance',authority=cert(domain,epoch)):LaneFact=>({
  atomicGroup:group(request),authority,payload:{kind:'authority-fence',scope:domain.startsWith('room:')?domain.slice(5):workspace,authorityScope:domain,mode}});
const interval=(from:number,to:number,facts:readonly LaneFact[]):LaneBatch=>({from:cut(from),to:cut(to),facts});
const settle=async()=>{for(let i=0;i<45;i++)await Promise.resolve();};
async function setup(requests:readonly LaneRequest[]=[a,b]){
  let reads=0;const writes:string[]=[],removes:string[]=[];
  const lanes=new ReadLanes(identity,()=>true,{write:async(_key,encoded)=>{writes.push(encoded);},floor:async()=>{},fence:async()=>{},remove:async key=>{removes.push(key);}});
  lanes.connected(1,['room-head','needs-you-count','needs-you'],async request=>{reads++;return base(request);});
  for(const request of requests)lanes.demand(request,{}, {isCurrent:()=>true});
  await settle();return {lanes,writes,removes,reads:()=>reads};
}

describe('classified per-group authority intervals',()=>{
  it('keeps allowed A live, hides B, and bridges only its verified interval without advancing its data cut or reading',async()=>{
    const {lanes,reads,writes}=await setup();
    await lanes.accept(interval(1,2,[replace(a),control(b,'room:b','2')]));
    expect(lanes.peek(a)).toMatchObject({state:'LIVE',value:{name:'new'},cut:{through:2}});
    expect(lanes.peek(b)).toMatchObject({value:null,cut:{through:1}});
    expect(writes.filter(value=>value.includes('room-head:b:ada'))).toHaveLength(1);
    await lanes.accept(interval(2,3,[replace(b,cert('room:b','2'),{name:'fresh B'})]));
    expect(lanes.peek(b)).toMatchObject({state:'LIVE',value:{name:'fresh B'},cut:{through:3}});
    expect(reads()).toBe(2);
  });
  it('a denial preserves only content-free continuity and a later higher grant replaces it',async()=>{
    const {lanes,reads,removes}=await setup();
    await lanes.accept(interval(1,2,[replace(a),control(b,'room:b','2','deny')]));
    expect(lanes.peek(b)).toMatchObject({state:'REVOKED',value:null,cut:null});
    expect(removes).toContain(JSON.stringify([identity.origin,identity.principal,group(b)]));
    await lanes.accept(interval(2,3,[replace(b,cert('room:b','3'))]));
    expect(lanes.peek(b)).toMatchObject({state:'LIVE',cut:{through:3}});expect(reads()).toBe(2);
    expect(lanes.peek(a)).toMatchObject({state:'LIVE',cut:{through:2}});
  });
  it('unknown/malformed controls park only their group and never invent a bridge',async()=>{
    const {lanes,reads}=await setup();
    await lanes.accept(interval(1,2,[replace(a),{atomicGroup:group(b),authority:cert('room:b'),payload:{kind:'group-unavailable',scope:'b',reason:'authority'}}]));
    expect(lanes.peek(a)).toMatchObject({state:'LIVE',cut:{through:2}});
    expect(lanes.peek(b)).toMatchObject({state:'PARKED',value:null,cut:null});
    await lanes.accept(interval(2,3,[replace(b,cert('room:b','2'))]));
    expect(lanes.peek(b).state).toBe('PARKED');expect(reads()).toBe(2);
    const second=await setup();
    await second.lanes.accept(interval(1,2,[replace(a),control(b,'reader:foreign:workspace:w','2')]));
    expect(second.lanes.peek(a).state).toBe('LIVE');expect(second.lanes.peek(b)).toMatchObject({state:'PARKED',value:null});
  });
  it('retains a reordered fresh replacement across the floor while discarding stale queued private data',async()=>{
    const {lanes,reads}=await setup();
    await lanes.accept(interval(2,3,[replace(a,cert('room:a'),{name:'future A'}),replace(b,cert('room:b','2'),{name:'future B'})]));
    await lanes.accept(interval(1,2,[replace(a),control(b,'room:b','2')]));await settle();
    expect(lanes.peek(a)).toMatchObject({state:'LIVE',value:{name:'future A'},cut:{through:3}});
    expect(lanes.peek(b)).toMatchObject({state:'LIVE',value:{name:'future B'},cut:{through:3}});expect(reads()).toBe(2);
    const stale=await setup();await stale.lanes.accept(interval(2,3,[replace(b,cert('room:b','1'),{name:'private stale'})]));
    await stale.lanes.accept(interval(1,2,[control(b,'room:b','2')]));await settle();
    expect(stale.lanes.peek(b).value).toBeNull();
    await stale.lanes.accept(interval(2,3,[replace(b,cert('room:b','2'))]));expect(stale.lanes.peek(b).state).toBe('LIVE');
  });
  it('a reparent floor and exact new-parent denial permit parent-only regrant at the unchanged child epoch',async()=>{
    const {lanes,reads}=await setup();const denied=cert('room:b','2','parent');
    await lanes.accept(interval(1,2,[control(b,'room:b','2','advance',denied),control(b,'room:parent','1','deny',denied)]));
    expect(lanes.peek(b)).toMatchObject({state:'REVOKED',value:null});
    const granted={...denied,scopes:denied.scopes.map(scope=>scope.authorityScope==='room:parent'?{...scope,epoch:'2'}:scope)};
    await lanes.accept(interval(2,3,[replace(b,granted)]));expect(lanes.peek(b).state).toBe('LIVE');expect(reads()).toBe(2);
  });
  it('retires count and full cells atomically, then publishes the complete fresh group together',async()=>{
    const {lanes,reads}=await setup([count,tray]);let watch=false;const seen:unknown[][]=[];
    const observe=()=>{if(watch)seen.push([lanes.peek(count).value,lanes.peek(tray).value]);};
    lanes.subscribe(count,observe);lanes.subscribe(tray,observe);watch=true;
    await lanes.accept(interval(1,2,[control(count,visibility,'2')]));expect(seen).toEqual([[null,null],[null,null]]);
    seen.length=0;const authority=cert(visibility,'2');
    await lanes.accept(interval(2,3,[replace(count,authority,{count:0}),replace(tray,authority,{count:0,items:[]})]));
    expect(seen).toEqual([[{count:0},{count:0,items:[]}],[{count:0},{count:0,items:[]}]]);expect(reads()).toBe(2);
  });
  it('a current no-visible-effect control classifies continuity but never rewrites the data cut',async()=>{
    const {lanes,reads,writes}=await setup([count]);
    await lanes.accept(interval(1,2,[control(count,visibility,'1')]));
    expect(lanes.peek(count)).toMatchObject({state:'LIVE',cut:{through:1}});expect(writes).toHaveLength(1);
    await lanes.accept(interval(2,3,[replace(count,cert(visibility))]));
    expect(lanes.peek(count)).toMatchObject({state:'LIVE',cut:{through:3}});expect(reads()).toBe(1);
  });
});
