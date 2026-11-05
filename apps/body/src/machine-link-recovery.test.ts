import {EventEmitter} from 'node:events';
import type WebSocket from 'ws';
import {afterEach,expect,it,vi} from 'vitest';
import {MachineLink} from './machine-link.js';

class Socket extends EventEmitter{
  readyState=0;onopen?:()=>void;onclose?:()=>void;onmessage?:(event:{data:string})=>void;
  frames:Record<string,any>[]=[];
  send(raw:string){this.frames.push(JSON.parse(raw));}
  open(){this.readyState=1;this.onopen?.();}
  close(){this.readyState=3;this.onclose?.();}
  terminate(){this.close();}
  receive(frame:Record<string,unknown>){this.onmessage?.({data:JSON.stringify(frame)});}
}
const cleanups:(()=>void)[]=[];
afterEach(()=>{for(const cleanup of cleanups.splice(0))cleanup();vi.useRealTimers();});
function fixture(count=1){
  const sockets:Socket[]=[],opened=vi.fn(),closed=vi.fn(),updated=vi.fn();
  const machine=new MachineLink({baseUrl:'http://synthetic.invalid',factory:()=>{const socket=new Socket();sockets.push(socket);return socket as unknown as WebSocket;}});
  const agents=Array.from({length:count},(_,index)=>machine.attach(`agent-${index}`,{
    registration:()=>({token:`bdt_${index}`}),onOpen:opened,onClose:closed,onMessage:()=>{},onUpdateRequired:updated}));
  for(const agent of agents)agent.start();cleanups.push(()=>machine.stop());
  const register=(socket:Socket)=>{socket.open();socket.receive({type:'registered-machine',agents:agents.map(agent=>({type:'registered',agentId:agent.agentId,capabilities:{}}))});};
  return {machine,sockets,agents,opened,closed,updated,register};
}
it('uses one handshake for all machine agents and reconnects once per actual close',async()=>{
  const {machine,sockets,opened,closed,register}=fixture(24);register(sockets[0]!);
  expect(sockets[0]!.frames).toHaveLength(1);expect(sockets[0]!.frames[0]!.agents).toHaveLength(24);expect(opened).toHaveBeenCalledTimes(24);
  for(let drop=1;drop<=4;drop++){
    sockets.at(-1)!.close();await Promise.resolve();expect(sockets).toHaveLength(drop+1);register(sockets.at(-1)!);
    expect(machine.link.reconnects).toBe(drop);expect(closed).toHaveBeenCalledTimes(24*drop);
  }
});
it.each(['registration','initial snapshots','intake heartbeat'])('does not close a living socket while %s is quiet',async()=>{
  vi.useFakeTimers();const {sockets,machine}=fixture();sockets[0]!.open();
  await vi.advanceTimersByTimeAsync(24*60*60*1000);
  expect(sockets).toHaveLength(1);expect(machine.link.state).toBe('connected');expect(machine.link.reconnects).toBe(0);
});
it('a refused registration neither reopens nor closes the machine connection',()=>{
  const {sockets,machine}=fixture();sockets[0]!.open();
  for(const code of ['registration_failed','too_many_agents','daemon_token_required'])sockets[0]!.receive({type:'register-refused',agentId:'agent-0',code});
  expect(sockets).toHaveLength(1);expect(machine.link.state).toBe('connected');
});
it('an explicit process stop or required version update leaves the connection disconnected',async()=>{
  const {machine,sockets,register,updated}=fixture();register(sockets[0]!);
  sockets[0]!.receive({type:'force-update',minVersion:'v999.0.0'});await Promise.resolve();
  expect(updated).toHaveBeenCalledWith('v999.0.0');expect(sockets).toHaveLength(1);expect(machine.link.state).toBe('disconnected');
  machine.stop();sockets[0]!.close();await Promise.resolve();expect(sockets).toHaveLength(1);
});
