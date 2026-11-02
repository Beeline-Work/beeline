import type { AddressInfo } from 'node:net';
import { setTimeout as realTimeout, clearTimeout as realClearTimeout } from 'node:timers';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TokenAuth } from '../../server/src/auth.js';
import type { DaemonService } from '../../server/src/daemon-service.js';
import type { SqlDatabase } from '../../server/src/database.js';
import { LiveHub } from '../../server/src/live.js';
import type { PhoneService } from '../../server/src/phone-service.js';
import { createBeelineServer } from '../../server/src/server.js';
import { DaemonApiClient } from './daemon-api-client.js';

const agentId = 'a'.repeat(64);
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const release of cleanup.splice(0)) await release(); vi.restoreAllMocks(); });
function deferred<T>() {
  let resolve!: (value:T) => void, reject!: (error:Error) => void;
  const promise = new Promise<T>((yes, no) => {resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
async function bounded<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof realTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = realTimeout(() => reject(new Error('Initial snapshot fixture did not reach its event')), 3_000);
  })]); } finally { realClearTimeout(timer); }
}
async function fixture(execute: ReturnType<typeof vi.fn>) {
  const live = new LiveHub(), authenticate = vi.fn(async () => agentId);
  const server = createBeelineServer({
    database:{query:vi.fn(),transaction:vi.fn()} as unknown as SqlDatabase,
    auth:{authenticateDaemon:authenticate,retiredDaemonAgent:async()=>null,authenticatePhone:async()=>null} as unknown as TokenAuth,
    phone:{canReadRooms:async(ids:string[])=>new Set(ids)} as unknown as PhoneService,
    daemon:{execute} as unknown as DaemonService, live, liveHeartbeatMs:30_000,
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const frames: Record<string,any>[] = [], sent: Record<string,any>[] = [], sockets: WebSocket[] = [];
  const fetcher = vi.fn(async () => {throw new Error('No HTTP recovery is admitted');});
  const api = new DaemonApiClient(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'bdt_synthetic', agentId, fetcher,
    (url, protocols, options) => {
      const socket = new WebSocket(url, protocols, options); sockets.push(socket);
      socket.on('message', raw => frames.push(JSON.parse(raw.toString())));
      const send = socket.send.bind(socket);
      socket.send = ((raw: string) => {sent.push(JSON.parse(raw)); send(raw);}) as typeof socket.send;
      return socket;
    });
  cleanup.push(async () => {
    api.closeLive(); sockets.forEach(socket => socket.terminate());
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return {api,live,frames,sent,sockets,authenticate,fetcher};
}

describe('actual machine initial snapshots', () => {
  it('never certifies a failing initial inbox or starts a register/subscribe reread loop', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined); vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const execute = vi.fn(async (name:string) => {
      if(name==='getRoomInbox')throw new Error('Synthetic initial database failure');
      return {commandProtocol:1,commands:[]};
    });
    const f = await fixture(execute), ended=deferred<void>(), state=vi.fn((connected:boolean)=>{if(!connected)ended.resolve();});
    f.api.liveSubscribe('room', undefined, () => undefined, state);
    await bounded(ended.promise);
    await new Promise<void>(resolve => realTimeout(resolve, 100));
    expect(f.authenticate).toHaveBeenCalledOnce();
    expect(execute.mock.calls.map(([name])=>name)).toEqual(['getRoomInbox']);
    expect(f.sent.filter(frame=>frame.type==='register')).toHaveLength(1);
    expect(f.sent.filter(frame=>frame.type==='subscribe')).toHaveLength(1);
    expect(f.frames.some(frame=>frame.type==='subscribed')).toBe(false);
    expect(state.mock.calls.some(([connected])=>connected)).toBe(false);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('negotiates command-only initial data and performs no unused inbox read on startup or message events', async () => {
    const execute = vi.fn(async (name:string) => {
      if(name!=='getAgentCommands')throw new Error('Unused inbox lane must not execute');
      return {commandProtocol:1,commands:[]};
    });
    const f=await fixture(execute), ready=deferred<void>();
    f.api.liveSubscribe('room',undefined,undefined,connected=>{if(connected)ready.resolve();});
    await bounded(ready.promise);
    const subscribed=f.frames.find(frame=>frame.type==='subscribed')!, commands=f.frames.find(frame=>frame.type==='commands')!;
    expect(subscribed).toMatchObject({requestId:expect.any(String),capabilities:{initialSnapshotsV1:true,inboxSnapshot:false}});
    expect(commands.requestId).toBe(subscribed.requestId);
    expect(f.frames.indexOf(commands)).toBeLessThan(f.frames.indexOf(subscribed));
    f.live.publish({type:'invalidate',roomId:'room',reason:'postgres:messages',messageId:'actual-committed-message'});
    await new Promise<void>(resolve=>realTimeout(resolve,100));
    expect(execute.mock.calls.map(([name])=>name)).toEqual(['getAgentCommands']); expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('fences an old awaited failure before a replacement subscription completes on the same registration', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const started=deferred<void>(), oldRead=deferred<{items:[]}>();
    const execute=vi.fn(async(name:string)=>{
      if(name==='getRoomInbox'){started.resolve();return oldRead.promise;}
      return {commandProtocol:1,commands:[]};
    });
    const f=await fixture(execute), ready=deferred<void>(), oldState=vi.fn(), newState=vi.fn((connected:boolean)=>{if(connected)ready.resolve();});
    f.api.setRoomsChangedListener(()=>undefined);
    const release=f.api.liveSubscribe('room',undefined,()=>undefined,oldState);
    await bounded(started.promise);
    release(); f.api.liveSubscribe('room',undefined,undefined,newState);
    // A FIFO ping/pong barrier proves cancellation reached the actual server
    // before completing the old application's awaited read.
    const socketPong=deferred<void>(); f.sockets[0]!.once('pong',()=>socketPong.resolve());
    f.sockets[0]!.ping('subscription-cancel-barrier'); await bounded(socketPong.promise);
    oldRead.reject(new Error('Old subscription failed after cancellation'));
    await bounded(ready.promise);
    expect(f.authenticate).toHaveBeenCalledOnce();
    expect(execute.mock.calls.map(([name])=>name)).toEqual(['getRoomInbox','getAgentCommands']);
    expect(oldState).not.toHaveBeenCalled(); expect(newState).toHaveBeenCalledOnce();
    expect(f.frames.some(frame=>frame.type==='unregistered')).toBe(false); expect(f.fetcher).not.toHaveBeenCalled();
    const ids=f.sent.filter(frame=>frame.type==='subscribe').map(frame=>frame.requestId);
    expect(ids).toHaveLength(2); expect(ids[0]).not.toBe(ids[1]);
  });
});
