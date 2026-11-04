import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonApiClient, type DaemonWebSocketFactory } from './daemon-api-client.js';
import { postChangedAgentUsage } from './helper-usage-binding.js';
const agent='a'.repeat(64),owner='b'.repeat(64),source={connectionId:'fixture-connection',epoch:1};
class Socket extends EventEmitter {
  readyState=0;onopen?:()=>void;onclose?:()=>void;onmessage?:(value:{data:string})=>void;
  frames:Record<string,any>[]=[];
  malformedReply=false;
  constructor(private readonly capable:boolean){super();}
  receive(value:Record<string,unknown>){this.onmessage?.({data:JSON.stringify({agentId:agent,...value})});}
  send(raw:string){const frame=JSON.parse(raw);this.frames.push(frame);
    if(frame.type==='register')this.receive({type:'registered',capabilities:this.capable?{usageAccountV1:true,usageOwnerId:owner,usageConnectionId:source.connectionId,usageConnectionEpoch:source.epoch}:{}});
    if(frame.type==='subscribe')this.receive({type:'subscribed',roomId:frame.roomId,capabilities:{pushIntake:true}});
    if(frame.type==='usage-operation')this.receive({type:'usage-result',requestId:frame.requestId,
      result:this.malformedReply?{}:frame.operation==='publishAgentUsageAccount'?{id:'ok',createdAt:1,ownerId:owner,accountId:'1',revision:'c'.repeat(64)}:{id:'ok',createdAt:1}});
  }
  terminate(){this.readyState=3;this.onclose?.();}close(){this.terminate();}
}
const cleanups:Array<()=>void>=[];afterEach(()=>{for(const cleanup of cleanups.splice(0))cleanup();vi.restoreAllMocks();});
function fixture(capable:boolean){
  const socket=new Socket(capable),fetcher=vi.fn(async()=>Response.json({id:'legacy',createdAt:1}));
  const api=new DaemonApiClient('http://synthetic.invalid','bdt_synthetic',agent,fetcher,(()=>socket as unknown as WebSocket) as DaemonWebSocketFactory);
  cleanups.push(()=>api.closeLive());api.liveSubscribe('room');socket.readyState=1;socket.onopen?.();return {socket,fetcher,api};
}
describe('actual daemon usage transport selection',()=>{
  it('uses only AgentChannel request/reply for every selected usage write, with zero fetch and no downgrade',async()=>{
    const {api,socket,fetcher}=fixture(true),usage={updatedAt:100,windows:[],context:{used:10,size:100}};
    await api.execute('publishAgentUsageAccount',{agentId:agent,ownerId:owner,usage:{updatedAt:100,windows:[],account:{provider:'claude',key:'id:'+'e'.repeat(32)}},revision:'d'.repeat(64),source});
    await api.execute('attachAgentUsageAccount',{agentId:agent,account:{provider:'claude',key:'id:'+'e'.repeat(32)},revision:'c'.repeat(64),source});
    await postChangedAgentUsage(api,agent,usage);await postChangedAgentUsage(api,agent,{...usage,updatedAt:101});
    expect(fetcher).not.toHaveBeenCalled();expect(socket.frames.filter(frame=>frame.type==='usage-operation').map(frame=>frame.operation)).toEqual([
      'publishAgentUsageAccount','attachAgentUsageAccount','postAgentUsage']);
    expect(socket.frames.find(frame=>frame.operation==='postAgentUsage')?.input).toMatchObject({usageSource:{v:1,ownerId:owner,source,revision:1}});
    api.closeLive();await expect(postChangedAgentUsage(api,agent,{...usage,context:{used:20,size:100}})).rejects.toThrow('unavailable');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('binds an existing collector report to the selected usage source without a new refusal',async()=>{
    const {api,socket,fetcher}=fixture(true),usage={updatedAt:300,windows:[],context:{used:37,size:100}};
    await api.execute('postAgentUsage',{agentId:agent,usage});
    await api.execute('postAgentUsage',{agentId:agent,usage:{...usage,updatedAt:301}});
    const writes=socket.frames.filter(frame=>frame.type==='usage-operation');
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({operation:'postAgentUsage',input:{usage,
      usageSource:{v:1,ownerId:owner,source,revision:expect.any(Number)}}});
    expect(fetcher).not.toHaveBeenCalled();
    api.closeLive();
    await expect(api.execute('postAgentUsage',{agentId:agent,usage:{...usage,context:{used:40,size:100}}})).rejects.toThrow('unavailable');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('parks a selected collector even when its socket closes before the first report',async()=>{
    const {api,fetcher}=fixture(true);api.closeLive();
    await expect(api.execute('postAgentUsage',{agentId:agent,usage:{updatedAt:1,windows:[]}})).rejects.toThrow('unavailable');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('refuses unsupported usage without an HTTP fallback',async()=>{
    const {api,socket,fetcher}=fixture(false);await expect(postChangedAgentUsage(api,agent,{updatedAt:100,windows:[],context:{used:10,size:100}})).rejects.toThrow('source required');
    expect(fetcher).not.toHaveBeenCalled();expect(socket.frames.some(frame=>frame.type==='usage-operation')).toBe(false);
  });
  it('rejects malformed exact-route parameters before sending and without invoking getters',async()=>{
    const {api,socket,fetcher}=fixture(true);let invoked=false;
    const malformed={agentId:agent,usage:{updatedAt:100,windows:'not-an-array'},source};
    Object.defineProperty(malformed,'unexpected',{enumerable:true,get(){invoked=true;return 'private';}});
    await expect(api.execute('publishAgentUsageAccount',malformed as never)).rejects.toThrow();
    expect(invoked).toBe(false);expect(socket.frames.some(frame=>frame.type==='usage-operation')).toBe(false);expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects a structurally incomplete server result without another request or HTTP fallback',async()=>{
    const {api,socket,fetcher}=fixture(true);socket.malformedReply=true;
    await expect(api.execute('attachAgentUsageAccount',{agentId:agent,account:{provider:'claude',key:'id:'+'e'.repeat(32)},revision:'c'.repeat(64),source})).rejects.toThrow('malformed');
    expect(socket.frames.filter(frame=>frame.type==='usage-operation')).toHaveLength(1);expect(fetcher).not.toHaveBeenCalled();
  });

});
