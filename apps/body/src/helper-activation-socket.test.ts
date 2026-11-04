import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { afterEach,describe,expect,it,vi } from 'vitest';
import { DaemonApiClient,type DaemonWebSocketFactory } from './daemon-api-client.js';
import { CommandActivationContext } from './helper-activation-context.js';
const agent='a'.repeat(64),source={connectionId:'synthetic-source',epoch:1};
const identity={agentId:agent,roomId:'room',workspaceId:'workspace',commandId:'command',generationId:'generation',source};
class Socket extends EventEmitter{
  readyState=0;onopen?:()=>void;onclose?:()=>void;onmessage?:(value:{data:string})=>void;
  frames:Record<string,any>[]=[];malformed=false;
  constructor(private readonly capable:boolean){super();}
  receive(value:Record<string,unknown>){this.onmessage?.({data:JSON.stringify({agentId:agent,...value})});}
  send(raw:string){const frame=JSON.parse(raw);this.frames.push(frame);
    if(frame.type==='register')this.receive({type:'registered',capabilities:this.capable?{activationContextV1:true,activationConnectionId:source.connectionId,activationConnectionEpoch:1}:{}});
    if(frame.type==='subscribe')this.receive({type:'subscribed',roomId:frame.roomId,capabilities:{pushIntake:true}});
    if(frame.type==='activation-context')this.receive({type:'activation-context-result',requestId:frame.requestId,result:this.malformed?{}:{...frame.input,v:1,capturedAt:100,
      authority:{generation:'b'.repeat(32),revision:1,commandRevision:'c'.repeat(64)},configuration:{fastMode:false,commands:[],yoloMode:false,isReviewer:false},roster:{members:[]},grants:{grants:[]},repository:{resolution:'none'}}});
  }
  terminate(){this.readyState=3;this.onclose?.();}close(){this.terminate();}
}
const cleanups:Array<()=>void>=[];afterEach(()=>{for(const cleanup of cleanups.splice(0))cleanup();});
function fixture(capable:boolean){
  const socket=new Socket(capable),fetcher=vi.fn(async()=>Response.json({}));
  const api=new DaemonApiClient('http://synthetic.invalid','bdt_synthetic',agent,fetcher,(()=>socket as unknown as WebSocket) as DaemonWebSocketFactory);
  cleanups.push(()=>api.closeLive());api.liveSubscribe('room');socket.readyState=1;socket.onopen?.();return {api,socket,fetcher};
}
describe('actual command setup machine adapter',()=>{
  it('uses one existing AgentChannel frame with zero fetch, including duplicate consumers and no downgrade after drop',async()=>{
    const {api,socket,fetcher}=fixture(true);
    const owner=new CommandActivationContext({scope:()=>api.channel.activationScope(),selected:()=>api.channel.activationContextSelected,read:input=>api.readCommandActivation(input)},()=>100);
    await Promise.all(Array.from({length:10},()=>owner.read(identity)));
    expect(socket.frames.filter(frame=>frame.type==='activation-context')).toHaveLength(1);expect(fetcher).not.toHaveBeenCalled();
    api.closeLive();await expect(owner.read(identity)).rejects.toThrow('parked');expect(fetcher).not.toHaveBeenCalled();
    await expect(api.execute('readCommandActivation',identity)).rejects.toThrow('machine adapter');expect(fetcher).not.toHaveBeenCalled();
  });
  it('keeps initial incapable cohort explicit and rejects getters/unknown params before sending',async()=>{
    const legacy=fixture(false);
    const owner=new CommandActivationContext({scope:()=>legacy.api.channel.activationScope(),selected:()=>legacy.api.channel.activationContextSelected,read:input=>legacy.api.readCommandActivation(input)},()=>100);
    expect(await owner.read(identity)).toBeUndefined();expect(legacy.socket.frames.some(frame=>frame.type==='activation-context')).toBe(false);
    const {api,socket,fetcher}=fixture(true);let invoked=false;
    const malformed={...identity};Object.defineProperty(malformed,'agentId',{enumerable:true,get(){invoked=true;return agent;}});
    await expect(api.readCommandActivation(malformed)).rejects.toThrow();expect(invoked).toBe(false);
    await expect(api.readCommandActivation({...identity,arbitrary:true} as never)).rejects.toThrow();
    expect(socket.frames.some(frame=>frame.type==='activation-context')).toBe(false);expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects malformed server context without another request or HTTP fallback',async()=>{
    const {api,socket,fetcher}=fixture(true);socket.malformed=true;
    await expect(api.readCommandActivation(identity)).rejects.toThrow('malformed');
    expect(socket.frames.filter(frame=>frame.type==='activation-context')).toHaveLength(1);expect(fetcher).not.toHaveBeenCalled();
  });
});
