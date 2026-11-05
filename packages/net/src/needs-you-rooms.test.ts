import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { NeedsYouRoomsPayload } from '@beeline/api-contract/router-protocol';
import { foldNeedsYouRooms, validateNeedsRoomsPayload } from './private/needs-you-rooms.js';
import { ReadLanes } from './private/read-lanes.js';
const workspace='11111111-1111-4111-8111-111111111111',changed='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333';
const item=(messageId:string,roomId=changed)=>({messageId,roomId,workspaceId:workspace,roomName:'Room',roomKind:'room' as const,text:'Please review?',createdAt:1});
const base={count:2,items:[item('old'),item('untouched',other)]};
const payload:NeedsYouRoomsPayload={kind:'needs-you-rooms-replace',scope:workspace,rooms:[{roomId:changed,items:[item('new')]}],order:['new','untouched'],count:2};
describe('server-authored Needs-you Room replacements',()=>{
  it('uses the exact server order, preserves unaffected cells and removes the replaced incarnation',()=>{
    const result=foldNeedsYouRooms(base,payload);
    expect(result).toEqual({count:2,items:[item('new'),base.items[1]]});
    expect(result.items[1]).toBe(base.items[1]);expect(base.items[0]!.messageId).toBe('old');
  });
  it('removes a Room using a complete empty replacement without inventing a cell or sorting',()=>{
    expect(foldNeedsYouRooms(base,{...payload,rooms:[{roomId:changed,items:[]}],order:['untouched'],count:1}))
      .toEqual({count:1,items:[base.items[1]]});
  });
  it('refuses incomplete coverage instead of reading or interpreting private eligibility',()=>{
    expect(()=>foldNeedsYouRooms(base,{...payload,order:['missing','new']})).toThrow('Incomplete');
  });
  it.each([
    {...payload,count:3}, {...payload,order:['new','new']},
    {...payload,rooms:[{roomId:changed,items:[{...item('new'),workspaceId:'foreign'}]}]},
    {...payload,rooms:[{roomId:changed,items:[item('new',other)]}]},
    {...payload,rooms:[{roomId:changed,items:Array.from({length:31},(_,n)=>item(String(n)))}]},
  ])('rejects malformed, foreign or over-budget data',value=>{expect(validateNeedsRoomsPayload(value)).toBe(false);});
  it('installs the count and changed cells at one group cut without another snapshot',async()=>{
    const needs={family:'needs-you' as const,workspaceId:workspace},badge={family:'needs-you-count' as const,workspaceId:workspace};
    const scopes=[{authorityScope:`reader:reader:workspace:${workspace}`,epoch:'1'},{authorityScope:`reader:reader:workspace:${workspace}:visibility`,epoch:'1'}];
    const authority={scopes,digest:createHash('sha256').update(JSON.stringify(scopes)).digest('hex')};
    const cut={stream:`workspace:${workspace}`,epoch:'epoch',protocol:1 as const,through:0},atomicGroup=`needs-you:${workspace}:reader`;
    const execute=vi.fn(async(request:typeof needs|typeof badge)=>({kind:'snapshot' as const,cut,authority,atomicGroup,
      value:request.family==='needs-you'?base:{count:2}}));
    const lanes=new ReadLanes({origin:'https://synthetic.invalid',principal:'reader',sessionEpoch:1},()=>true);
    lanes.connected(1,['needs-you','needs-you-count'],execute);
    const installed=Promise.all([needs,badge].map(request=>new Promise<void>(resolve=>{
      lanes.subscribe(request,()=>{if(lanes.peek(request).state==='LIVE')resolve();});lanes.demand(request,{}, {isCurrent:()=>true});
    })));
    await installed;
    const complete=new Promise<void>(resolve=>{
      const check=()=>{if(lanes.peek(needs).cut?.through===1&&lanes.peek(badge).cut?.through===1)resolve();};
      lanes.subscribe(needs,check);lanes.subscribe(badge,check);
    });
    await lanes.accept({from:cut,to:{...cut,through:1},facts:[{atomicGroup,authority,payload},
      {atomicGroup,authority,payload:{kind:'scope-replace',family:'needs-you-count',scope:workspace,value:{count:2}}}]});
    await complete;
    expect(lanes.peek(needs).value).toEqual({count:2,items:[item('new'),item('untouched',other)]});
    expect(lanes.peek(badge).cut).toEqual(lanes.peek(needs).cut);expect(execute).toHaveBeenCalledTimes(2);
  });
});
