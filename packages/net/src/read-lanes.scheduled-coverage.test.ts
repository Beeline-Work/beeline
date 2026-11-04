import {expect,it} from 'vitest';
import {ReadLanes,type LaneRequest,type LaneSnapshot,type LaneBatch} from './private/read-lanes.js';
const a:LaneRequest={family:'room-scheduled-work',roomId:'a',workspaceId:'w'};
const b:LaneRequest={family:'room-scheduled-work',roomId:'b',workspaceId:'w'};
const cut=(through:number)=>({stream:'workspace:w',epoch:'e',through,protocol:1 as const});
const cert=(roomId:string,epoch='1')=>({digest:'test',scopes:[{authorityScope:`scheduled-work-room:${roomId}`,epoch}]});
const base=(request:LaneRequest):LaneSnapshot=>({kind:'snapshot',value:{name:request.roomId},cut:cut(1),atomicGroup:`room-scheduled-work:${request.roomId}:p`,authority:cert(request.roomId!)});
const marker=(from:number,to:number):LaneBatch=>({from:cut(from),to:cut(to),facts:[],scheduledWorkClassification:{kind:'scheduled-work-classification',version:1,authorityBarrier:{stream:'authority:p',epoch:'ae',segment:'s',through:to,protocol:1}}});
const replacement=(from:number,to:number,roomId='a',epoch='1'):LaneBatch=>({...marker(from,to),facts:[{atomicGroup:`room-scheduled-work:${roomId}:p`,authority:cert(roomId,epoch),payload:{kind:'scope-replace',family:'room-scheduled-work',scope:roomId,value:{name:'changed'}}}]});
const settle=async()=>{for(let i=0;i<45;i++)await Promise.resolve();};
async function setup(enabled=true){let reads=0,writes=0,publishes=0;const lanes=new ReadLanes({origin:'test',principal:'p',sessionEpoch:1},()=>true,{write:async()=>{writes++;},remove:async()=>{},floor:async()=>{},fence:async()=>{}});
lanes.connected(1,['room-scheduled-work'],async request=>{reads++;return base(request);},{scheduledWorkCoverageV1:enabled});
const releases=[a,b].map(request=>lanes.demand(request,{}, {isCurrent:()=>true}));await settle();lanes.subscribe(a,()=>{publishes++;});return {lanes,releases,counts:()=>({reads,writes,publishes})};}
it('classifies unchanged A without persistence or publication, then accepts its contiguous edit and reuses inactive data',async()=>{
const {lanes,releases,counts}=await setup();releases[0]!();const before=counts();const view=lanes.peek(a);
await lanes.accept(marker(1,2));expect(lanes.peek(a)).toBe(view);expect(counts()).toEqual(before);
await lanes.accept(replacement(2,3));expect(lanes.peek(a)).toMatchObject({state:'INACTIVE_CACHED',value:{name:'changed'},cut:{through:3}});
lanes.demand(a,{}, {isCurrent:()=>true});await settle();expect(counts().reads).toBe(2);
});
it('a marker cannot invent continuity when not negotiated',async()=>{
const {lanes,counts}=await setup(false);const before=counts().writes;await lanes.accept(marker(1,2));await lanes.accept(replacement(2,3));expect(lanes.peek(a)).toMatchObject({value:{name:'a'},cut:{through:1}});expect(counts().writes).toBe(before);
});
it('a missing data interval stages later classification until the exact missing interval arrives',async()=>{
const {lanes,counts}=await setup();await lanes.accept(marker(2,3));await lanes.accept(replacement(3,4));expect(lanes.peek(a).cut?.through).toBe(1);
await lanes.accept(marker(1,2));await settle();expect(lanes.peek(a)).toMatchObject({value:{name:'changed'},cut:{through:4}});expect(counts().reads).toBe(2);
});
it('a durable higher B floor hides B while unchanged A remains usable; markers cannot revive B',async()=>{
const {lanes,counts}=await setup();await lanes.advance('scheduled-work-room:b','2');await lanes.accept(marker(1,2));expect(lanes.peek(b).value).toBeNull();expect(lanes.peek(a).value).toEqual({name:'a'});
await lanes.accept(replacement(2,3));expect(lanes.peek(a).cut?.through).toBe(3);expect(lanes.peek(b).value).toBeNull();expect(counts().reads).toBe(2);
});
it('disconnect and local unavailable discard classification without admitting a read',async()=>{
const {lanes,counts}=await setup();await lanes.accept(marker(1,2));lanes.unavailable('workspace:w','room-scheduled-work');await lanes.accept(marker(2,3));expect(lanes.peek(a).state).toBe('PARKED');
lanes.disconnected();await lanes.accept(replacement(3,4));expect(lanes.peek(a).value).toBeNull();expect(counts().reads).toBe(2);
});
it('retains Scheduled classification when a ready future interval merges independent count facts',async()=>{
  const count:LaneRequest={family:'needs-you-count',workspaceId:'w'};
  const countFact=(value:number)=>({atomicGroup:'needs-you:w:p',authority:cert('reader'),payload:{kind:'scope-replace' as const,family:'needs-you-count' as const,scope:'w',value:{count:value}}});
  const lanes=new ReadLanes({origin:'test',principal:'p',sessionEpoch:1},()=>true);
  lanes.connected(1,['room-scheduled-work','needs-you-count'],async request=>request.family==='room-scheduled-work'?base(request):
    {kind:'snapshot',value:{count:1},cut:cut(1),atomicGroup:'needs-you:w:p',authority:cert('reader')},{scheduledWorkCoverageV1:true});
  lanes.demand(a,{}, {isCurrent:()=>true});lanes.demand(count,{}, {isCurrent:()=>true});await settle();
  await lanes.accept(marker(2,3));await lanes.accept({from:cut(2),to:cut(3),facts:[countFact(3)]});
  await lanes.accept({...marker(1,2),facts:[countFact(2)]});await settle();
  await lanes.accept(replacement(3,4));await settle();
  expect(lanes.peek(a)).toMatchObject({value:{name:'changed'},cut:{through:4}});
  expect(lanes.peek(count)).toMatchObject({value:{count:3},cut:{through:3}});
});
