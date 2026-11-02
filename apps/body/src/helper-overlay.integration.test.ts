import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MachineLink } from './machine-link.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { AgentTurnStream } from './turn-stream.js';
class Socket extends EventEmitter {
  readyState=0;onopen?:()=>void;onclose?:()=>void;onmessage?:(event:{data:string})=>void;
  frames:Record<string,any>[]=[];
  send(text:string){const frame=JSON.parse(text);this.frames.push(frame);
    if(frame.type==='overlay-update')this.receive({type:'overlay-ack',requestId:frame.requestId,accepted:true,revision:frame.frame.revision});}
  receive(frame:Record<string,unknown>){this.onmessage?.({data:JSON.stringify({agentId:'agent',...frame})});}
  terminate(){this.readyState=3;this.onclose?.();}close(){this.terminate();}
}
const cleanups:Array<()=>void>=[];afterEach(()=>{for(const cleanup of cleanups.splice(0))cleanup();});
const settle=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
function fixture(capable:boolean){
  const socket=new Socket(),machine=new MachineLink({baseUrl:'http://synthetic.invalid',factory:()=>socket as unknown as WebSocket});
  cleanups.push(()=>machine.stop());
  const channel=machine.attach('agent',{registration:()=>({token:'synthetic'}),onOpen:()=>undefined,onClose:()=>undefined,onMessage:()=>undefined,onUpdateRequired:()=>undefined});
  channel.start();socket.readyState=1;socket.onopen?.();socket.receive({type:'registered',capabilities:{overlayV1:capable}});
  const execute=vi.fn(async()=>({id:'synthetic-result'}));
  const stream=new AgentTurnStream({api:{channel,execute} as unknown as DaemonApiClient,agentId:'agent',roomId:'room',requestId:'turn',
    commandId:'command',turnGeneration:'generation',label:'synthetic'});
  return {socket,machine,channel,stream,execute};
}
describe('actual streamed-turn negotiated helper socket adapter',()=>{
  it('retains locally at zero viewers, sends fresh baseline+UTF8 append, and keeps durable reply separate',async()=>{
    const {socket,stream,execute}=fixture(true);
    stream.onChunk('🌍','🌍','🌍');await settle();expect(execute).not.toHaveBeenCalled();
    expect(socket.frames.filter(frame=>frame.type==='overlay-update')).toHaveLength(0);
    socket.receive({type:'overlay-demand',v:1,roomId:'room',viewing:true,viewingRevision:1});await settle();
    stream.onChunk('é','🌍é','🌍é');await settle();
    const frames=socket.frames.filter(frame=>frame.type==='overlay-update').map(frame=>frame.frame);
    expect(frames[0]).toMatchObject({commandId:'command',turnGeneration:'generation',type:'baseline',text:'🌍'});
    expect(frames[1]).toMatchObject({type:'append',offset:4,text:'é'});
    await stream.settle('durable final');
    expect(execute).toHaveBeenCalledTimes(1);expect(execute).toHaveBeenCalledWith('postRoomMessage',expect.objectContaining({text:'durable final'}));
    stream.onChunk('late','late','late');expect(execute).toHaveBeenCalledTimes(1);
  });
  it('preserves old-server draft transport while never downgrading a selected capable stream after drop',async()=>{
    const legacy=fixture(false);legacy.stream.onChunk('old','old','old');await settle();
    expect(legacy.execute).toHaveBeenCalledWith('postAgentDraft',expect.objectContaining({text:'old'}));
    const capable=fixture(true);capable.socket.receive({type:'overlay-demand',v:1,roomId:'room',viewing:true,viewingRevision:1});await settle();
    capable.stream.onChunk('selected','selected','selected');await settle();
    capable.machine.stop();capable.stream.onChunk('after drop','after drop','after drop');await settle();
    expect(capable.execute).not.toHaveBeenCalled();await legacy.stream.retract();await capable.stream.retract();
  });
});
