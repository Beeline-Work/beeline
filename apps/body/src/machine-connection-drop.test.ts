import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { expect, it, vi } from 'vitest';
import { MachineLink } from './machine-link.js';
import { DaemonApiClient } from './daemon-api-client.js';
import { createBeelineServer } from '../../server/src/server.js';
import { migratedDatabase } from '../../server/src/test-support.js';
import type { DaemonService } from '../../server/src/daemon-service.js';
import type { TokenAuth } from '../../server/src/auth.js';
import type { PhoneService } from '../../server/src/phone-service.js';
import { LiveHub } from '../../server/src/live.js';

const agentId='ab'.repeat(32);
const gate=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};

it('DROP-24: completes every turn across repeated mid-turn drops with one reconnect per drop and no failed requests',async()=>{
  const database=await migratedDatabase();
  const claimGate=gate(),effectGate=gate();
  const claimed=new Set<string>(),completed=new Set<string>();
  const calls=new Map<string,number>();
  const daemon={execute:vi.fn(async(name:string,input:Record<string,any>)=>{
    const key=JSON.stringify([name,input.roomId]);calls.set(key,(calls.get(key)??0)+1);
    if(name==='getAgentCommands')return {commandProtocol:1,commands:[]};
    if(name==='getRoomInbox')return {items:[],cursor:undefined};
    if(name==='claimAgentCommand'){
      claimed.add(input.roomId);await claimGate.promise;return {id:input.commandId,createdAt:1};
    }
    if(name==='postRoomMessage'){
      completed.add(input.roomId);await effectGate.promise;return {id:input.requestId,createdAt:1};
    }
    return {id:input.commandId??'ok',createdAt:1};
  })} as unknown as DaemonService;
  const server=createBeelineServer({database,daemon,
    auth:{authenticateDaemon:async()=>agentId,retiredDaemonAgent:async()=>null} as unknown as TokenAuth,
    phone:{canReadRooms:async(ids:string[])=>new Set(ids)} as unknown as PhoneService,
    live:new LiveHub(),mediaMaximumBytes:1});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const sockets:WebSocket[]=[];
  const frames:Record<string,any>[][]=[];
  const machine=new MachineLink({baseUrl:`http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    factory:(url,protocols,options)=>{
      const socket=new WebSocket(url,protocols,options);sockets.push(socket);const sent:Record<string,any>[]=[];frames.push(sent);
      const send=socket.send.bind(socket);socket.send=((data:any,...args:any[])=>{sent.push(JSON.parse(String(data)));return (send as any)(data,...args);}) as typeof socket.send;
      return socket;
    }});
  const fetcher=vi.fn(()=>{throw new Error('machine requests must not use HTTP');});
  const api=new DaemonApiClient(machine.origin,'bdt_test',agentId,fetcher,undefined,undefined,undefined,machine);
  const failures:unknown[]=[];
  const rooms=Array.from({length:24},(_,index)=>`room-${index}`);
  const subscriptions=rooms.map(room=>api.liveSubscribe(room));
  const drop=async()=>{
    const socket=sockets.at(-1)!;
    const count=sockets.length;
    socket.terminate();
    await vi.waitFor(()=>expect(sockets.length).toBe(count+1));
    await vi.waitFor(()=>expect(api.channel.isOpen()).toBe(true));
  };
  try{
    await vi.waitFor(()=>expect(api.channel.isOpen()).toBe(true));
    const turns=rooms.map(async roomId=>{
      await api.execute('claimAgentCommand',{roomId,commandId:`command-${roomId}`,generationId:`generation-${roomId}`});
      await api.execute('postRoomMessage',{roomId,requestId:`command-${roomId}`,generationId:`generation-${roomId}`,text:'completed'});
      await api.execute('acknowledgeAgentCommand',{roomId,commandId:`command-${roomId}`});
    });
    for(const turn of turns)void turn.catch(error=>{failures.push(error);});
    await vi.waitFor(()=>expect(claimed.size).toBe(24));
    await drop();await drop(); // All accepted claims remain in flight.
    claimGate.resolve();
    await vi.waitFor(()=>expect(completed.size).toBe(24));
    await drop();await drop(); // Effects committed, replies still withheld.
    effectGate.resolve();
    await Promise.all(turns);
    expect(failures).toEqual([]);
    expect(completed.size).toBe(24);
    expect(machine.link.reconnects).toBe(4);
    expect(sockets).toHaveLength(5);
    expect(fetcher).not.toHaveBeenCalled();
    for(const roomId of rooms){
      expect(calls.get(JSON.stringify(['claimAgentCommand',roomId]))).toBe(1);
      expect(calls.get(JSON.stringify(['postRoomMessage',roomId]))).toBe(1);
      expect(calls.get(JSON.stringify(['acknowledgeAgentCommand',roomId]))).toBe(1);
    }
    expect(frames.flat().filter(frame=>frame.type==='request-result').length).toBeGreaterThanOrEqual(96);
    for(const sent of frames){
      expect(sent.filter(frame=>frame.type==='register-machine')).toHaveLength(1);
      for(const roomId of rooms)expect(sent.filter(frame=>frame.type==='subscribe'&&frame.roomId===roomId)).toHaveLength(1);
    }
  }finally{
    claimGate.resolve();effectGate.resolve();for(const unsubscribe of subscriptions)unsubscribe();machine.stop();
    for(const socket of sockets)socket.terminate();
    const closed=once(server,'close');server.close();await closed;await database.close();
  }
},30_000);
