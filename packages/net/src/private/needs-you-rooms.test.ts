
import { createHash as move14_createHash } from 'node:crypto';

import { describe as move14_describe, expect as move14_expect, it as move14_it, vi as move14_vi } from 'vitest';

import type { NeedsYouRoomsPayload as move14_NeedsYouRoomsPayload } from '@beeline/api-contract/router-protocol';

import { foldNeedsYouRooms as move14_foldNeedsYouRooms, validateNeedsRoomsPayload as move14_validateNeedsRoomsPayload } from "./needs-you-rooms.js";

import { ReadLanes as move14_ReadLanes } from "./read-lanes.js";
import { describe as movedDescribe14 } from 'vitest';
movedDescribe14("needs-you-rooms.test.ts", () => {

const workspace='11111111-1111-4111-8111-111111111111',changed='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333';

const item=(messageId:string,roomId=changed)=>({messageId,roomId,workspaceId:workspace,roomName:'Room',roomKind:'room' as const,text:'Please review?',createdAt:1});

const base={count:2,items:[item('old'),item('untouched',other)]};

const payload:move14_NeedsYouRoomsPayload={kind:'needs-you-rooms-replace',scope:workspace,rooms:[{roomId:changed,items:[item('new')]}],order:['new','untouched'],count:2};

move14_describe('server-authored Needs-you Room replacements',()=>{
  move14_it('uses the exact server order, preserves unaffected cells and removes the replaced incarnation',()=>{
    const result=move14_foldNeedsYouRooms(base,payload);
    move14_expect(result).toEqual({count:2,items:[item('new'),base.items[1]]});
    move14_expect(result.items[1]).toBe(base.items[1]);move14_expect(base.items[0]!.messageId).toBe('old');
  });
  move14_it('removes a Room using a complete empty replacement without inventing a cell or sorting',()=>{
    move14_expect(move14_foldNeedsYouRooms(base,{...payload,rooms:[{roomId:changed,items:[]}],order:['untouched'],count:1}))
      .toEqual({count:1,items:[base.items[1]]});
  });
  move14_it('refuses incomplete coverage instead of reading or interpreting private eligibility',()=>{
    move14_expect(()=>move14_foldNeedsYouRooms(base,{...payload,order:['missing','new']})).toThrow('Incomplete');
  });
  move14_it.each([
    {...payload,count:3}, {...payload,order:['new','new']},
    {...payload,rooms:[{roomId:changed,items:[{...item('new'),workspaceId:'foreign'}]}]},
    {...payload,rooms:[{roomId:changed,items:[item('new',other)]}]},
    {...payload,rooms:[{roomId:changed,items:Array.from({length:31},(_,n)=>item(String(n)))}]},
  ])('rejects malformed, foreign or over-budget data',value=>{move14_expect(move14_validateNeedsRoomsPayload(value)).toBe(false);});
  move14_it('installs the count and changed cells at one group cut without another snapshot',async()=>{
    const needs={family:'needs-you' as const,workspaceId:workspace},badge={family:'needs-you-count' as const,workspaceId:workspace};
    const scopes=[{authorityScope:`reader:reader:workspace:${workspace}`,epoch:'1'},{authorityScope:`reader:reader:workspace:${workspace}:visibility`,epoch:'1'}];
    const authority={scopes,digest:move14_createHash('sha256').update(JSON.stringify(scopes)).digest('hex')};
    const cut={stream:`workspace:${workspace}`,epoch:'epoch',protocol:1 as const,through:0},atomicGroup=`needs-you:${workspace}:reader`;
    const execute=move14_vi.fn(async(request:typeof needs|typeof badge)=>({kind:'snapshot' as const,cut,authority,atomicGroup,
      value:request.family==='needs-you'?base:{count:2}}));
    const lanes=new move14_ReadLanes({origin:'https://synthetic.invalid',principal:'reader',sessionEpoch:1},()=>true);
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
    move14_expect(lanes.peek(needs).value).toEqual({count:2,items:[item('new'),item('untouched',other)]});
    move14_expect(lanes.peek(badge).cut).toEqual(lanes.peek(needs).cut);move14_expect(execute).toHaveBeenCalledTimes(2);
  });
});
});
