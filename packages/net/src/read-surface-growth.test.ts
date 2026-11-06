import {describe,expect,it} from 'vitest';
import {routes} from './routes.js';

const workspace='11111111-1111-4111-8111-111111111111';
const room='22222222-2222-4222-8222-222222222222';
const item=(n:number)=>({messageId:`question-${n}`,workspaceId:workspace,roomId:room,roomName:'Room',roomKind:'room' as const,text:'Please review?',createdAt:1});

describe('large plain read results',()=>{
  it('validates results above the former byte, node, and validation-work quotas',()=>{
    const items=Array.from({length:6000},(_,n)=>item(n));
    const result={needs:{items},saved:{bookmarks:[]}};
    expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(256*1024);
    expect(routes['phone.readTray'].result.parse(result)).toBe(result);
    expect(routes['phone.readNeedsYou'].result.parse({items})).toEqual({items});
  });

  it('validates a large Scheduled Work response',()=>{
    const result={roomName:'Room',agentNames:Array.from({length:101},(_,n)=>[String(n),'x'.repeat(4096)]),schedules:[],subscriptions:[]};
    expect(Buffer.byteLength(JSON.stringify(result))).toBeGreaterThan(256*1024);
    expect(routes['phone.readScheduledWork'].result.parse(result)).toBe(result);
  });

  it('still rejects invalid response fields and non-JSON values',()=>{
    expect(()=>routes['phone.readNeedsYou'].result.parse({items:[{...item(1),createdAt:'bad'}]})).toThrow('contract mismatch');
    const cyclic:Record<string,unknown>={};cyclic.self=cyclic;
    expect(()=>routes['phone.readNeedsYou'].result.parse(cyclic)).toThrow('cyclic value');
    const getter={get items(){throw new Error('must not execute');}};
    expect(()=>routes['phone.readNeedsYou'].result.parse(getter)).toThrow('accessor');
    expect(()=>routes['phone.readNeedsYou'].result.parse({items:[{...item(1),createdAt:Infinity}]})).toThrow('non-JSON value');
  });

  it('keeps the existing request input budget',()=>{
    expect(()=>routes['phone.sendRoomMessage'].params.parse({roomId:room,messageId:'a'.repeat(64),text:'x'.repeat(64*1024)})).toThrow('byte limit');
  });
});
