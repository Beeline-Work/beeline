import {EventEmitter} from 'node:events';
import type WebSocket from 'ws';
import {afterEach,expect,it,vi} from 'vitest';
import {DaemonApiClient} from './daemon-api-client.js';
import {MachineLink} from './machine-link.js';

const agentId='ab'.repeat(32);
class Socket extends EventEmitter {
  readyState=0;
  onopen?:()=>void;onclose?:()=>void;onmessage?:(message:{data:string})=>void;
  frames:Record<string,any>[]=[];
  send(raw:string){this.frames.push(JSON.parse(raw));}
  receive(frame:Record<string,unknown>){this.onmessage?.({data:JSON.stringify({agentId,...frame})});}
  open(){this.readyState=1;this.onopen?.();}
  register(epoch=1){this.receive({type:'registered',capabilities:{daemonOperationsV1:true,activationConnectionId:'connection',activationConnectionEpoch:epoch,turnConnectionId:'connection',turnConnectionEpoch:epoch}});}
  close(){this.readyState=3;this.onclose?.();}
  terminate(){this.close();}
}
const cleanups:(()=>void)[]=[];
afterEach(()=>{for(const cleanup of cleanups.splice(0))cleanup();vi.useRealTimers();});
function fixture(){
  const sockets:Socket[]=[];
  const machine=new MachineLink({baseUrl:'http://synthetic.invalid',factory:()=>{const socket=new Socket();sockets.push(socket);return socket as unknown as WebSocket;}});
  const fetcher=vi.fn(async()=>{throw new Error('unexpected HTTP request');});
  const api=new DaemonApiClient(machine.origin,'bdt_test',agentId,fetcher,undefined,undefined,undefined,machine);
  cleanups.push(()=>machine.stop());return {api,machine,sockets,fetcher};
}
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};

it('waits for registration before bootstrap or any ordinary request',async()=>{
  const {api,sockets,fetcher}=fixture();
  const request=api.execute('getDaemonBootstrap',{agentId});
  expect(sockets).toHaveLength(1);sockets[0]!.open();await flush();
  expect(sockets[0]!.frames).toEqual([expect.objectContaining({type:'register-machine',agents:[expect.objectContaining({agentId})]})]);
  sockets[0]!.register();await flush();
  const frame=sockets[0]!.frames.find(frame=>frame.type==='daemon-operation')!;
  sockets[0]!.receive({type:'daemon-operation-result',requestId:frame.requestId,result:{id:'bootstrap'}});
  await expect(request).resolves.toEqual({id:'bootstrap'});expect(fetcher).not.toHaveBeenCalled();
});
it('registration refusal leaves requests waiting without another socket or a timer',async()=>{
  vi.useFakeTimers();const {api,sockets,machine}=fixture();let settled=false;
  const request=api.execute('getAgentConfiguration',{agentId}).finally(()=>{settled=true;});
  sockets[0]!.open();sockets[0]!.receive({type:'register-refused',code:'registration_failed'});
  await vi.advanceTimersByTimeAsync(24*60*60*1000);
  expect(settled).toBe(false);expect(sockets).toHaveLength(1);expect(machine.link.reconnects).toBe(0);
  sockets[0]!.register();await flush();const frame=sockets[0]!.frames.find(frame=>frame.type==='daemon-operation')!;
  sockets[0]!.receive({type:'daemon-operation-result',requestId:frame.requestId,result:{id:'ready'}});
  await expect(request).resolves.toEqual({id:'ready'});
});
it('elapsed time, pongs, and refused requests never reconnect a living socket',async()=>{
  vi.useFakeTimers();const {api,sockets,machine}=fixture();
  const request=api.execute('getAgentConfiguration',{agentId});const outcome=request.catch(error=>error);
  sockets[0]!.open();sockets[0]!.register();await flush();
  await vi.advanceTimersByTimeAsync(24*60*60*1000);sockets[0]!.emit('pong');
  const frame=sockets[0]!.frames.find(frame=>frame.type==='daemon-operation')!;
  sockets[0]!.receive({type:'daemon-operation-result',requestId:frame.requestId,error:'access denied',status:403});
  expect(await outcome).toMatchObject({status:403,retryable:false});expect(machine.link.reconnects).toBe(0);expect(sockets).toHaveLength(1);
});
it('re-reads an in-flight request by id after close without replaying its operation',async()=>{
  const {api,sockets,machine}=fixture();const request=api.execute('getAgentConfiguration',{agentId});
  sockets[0]!.open();sockets[0]!.register();await flush();
  const frame=sockets[0]!.frames.find(frame=>frame.type==='daemon-operation')!;
  sockets[0]!.close();await flush();expect(sockets).toHaveLength(2);
  sockets[1]!.open();sockets[1]!.register(2);await flush();
  expect(sockets[1]!.frames).toContainEqual({type:'request-result',requestId:frame.requestId,agentId});
  expect(sockets[1]!.frames.some(frame=>frame.type==='daemon-operation')).toBe(false);
  sockets[1]!.receive({type:'daemon-operation-result',requestId:frame.requestId,result:{id:'original'}});
  await expect(request).resolves.toEqual({id:'original'});expect(machine.link.reconnects).toBe(1);
});
it('sends waiting requests once and only dispatches a missing in-flight id after the server proves it absent',async()=>{
  const {api,sockets}=fixture();const first=api.execute('getAgentConfiguration',{agentId});
  sockets[0]!.open();sockets[0]!.register();await flush();
  const original=sockets[0]!.frames.find(frame=>frame.type==='daemon-operation')!;
  sockets[0]!.close();const waiting=api.execute('getDaemonBootstrap',{agentId});await flush();
  sockets[1]!.open();sockets[1]!.register(2);await flush();
  expect(sockets[1]!.frames.filter(frame=>frame.type==='daemon-operation')).toHaveLength(1);
  sockets[1]!.receive({type:'request-missing',requestId:original.requestId});await flush();
  const operations=sockets[1]!.frames.filter(frame=>frame.type==='daemon-operation');expect(operations).toHaveLength(2);
  expect(operations[1]!.requestId).toBe(original.requestId);
  for(const frame of operations)sockets[1]!.receive({type:'daemon-operation-result',requestId:frame.requestId,result:{id:'ok'}});
  await Promise.all([first,waiting]);
});
it('uses one operation path for activation, usage, and turn control',async()=>{
  const {api,sockets}=fixture();const ready=api.waitForConnection();sockets[0]!.open();sockets[0]!.register();await ready;
  const tasks=[api.readCommandActivation({agentId,roomId:'room',workspaceId:'workspace',commandId:'command',generationId:'generation',source:{connectionId:'connection',epoch:1}}),
    api.execute('claimAgentCommand',{roomId:'room',commandId:'command',generationId:'generation'}),
    api.execute('publishAgentUsageAccount',{agentId} as never)];
  await flush();const operations=sockets[0]!.frames.filter(frame=>frame.type==='daemon-operation');expect(operations).toHaveLength(3);
  for(const frame of operations)sockets[0]!.receive({type:'daemon-operation-result',requestId:frame.requestId,result:{id:'ok'}});
  await Promise.all(tasks);
});
