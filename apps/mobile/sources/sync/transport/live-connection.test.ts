import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ currentState: 'active', platform: 'android', listeners: new Set<(value: string) => void>(), network: new Set<(value: { isConnected: boolean; isInternetReachable: boolean }) => void>() }));
vi.mock('react-native', () => ({
  Platform: { get OS() { return state.platform; } }, NativeModules: { RNCNetInfo: {} },
  NativeEventEmitter: class { addListener(_name: string, listener: (value: { isConnected: boolean; isInternetReachable: boolean }) => void) {
    state.network.add(listener); return { remove: () => state.network.delete(listener) };
  } }, AppState: { get currentState() { return state.currentState; },
  addEventListener: (_event: string, listener: (value: string) => void) => {
    state.listeners.add(listener); return { remove: () => state.listeners.delete(listener) };
  } } }));
vi.mock('@/auth/monolith-session', () => ({
  MonolithRequestTimeoutError: class MonolithRequestTimeoutError extends Error {},
  MonolithSessionChangedError: class MonolithSessionChangedError extends Error {},
  monolithSession: { authorization: async () => 'fixture-access', invalidateAuthorization: vi.fn() },
}));
vi.mock('react', () => ({ useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot() }));
import { LiveConnection, useConnectionFailure, subscribeNetworkOnline, sharedLiveConnection, resetSharedLiveConnection } from './live-connection';
import { PhoneSocketDisconnectedError } from './phone-socket-error';

class Socket {
  static readonly OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  sent: string[] = [];
  autoPong = true;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  constructor(readonly url: string, readonly protocols: string[]) { Socket.instances.push(this); }
  send(frame: string) { this.sent.push(frame); if (frame === '{"type":"ping"}' && this.autoPong) this.emit({type:'pong'}); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  emit(frame: unknown) { this.onmessage?.({data:JSON.stringify(frame)}); }
  drop() { this.readyState = 3; this.onclose?.(); }
  fail() { this.onerror?.(); }
  requests() { return this.sent.map(value=>JSON.parse(value)).filter(frame=>frame.t==='req'); }
  reply(result: unknown, index = 0) { this.emit({t:'res',id:this.requests()[index].id,ok:true,result}); }
  refuse(index = 0) { this.emit({t:'res',id:this.requests()[index].id,ok:false,error:{code:'unavailable',message:'Read unavailable',retryable:true}}); }
}
const connections: LiveConnection[] = [];
function setup(authorization = vi.fn(async () => 'fixture-access')) {
  let changed = () => {};
  const invalidate = vi.fn();
  const connection = new LiveConnection({ authorization, invalidateAuthorization:invalidate,
    subscribeNetworkOnline, liveUrl:()=> 'ws://fixture.invalid/v1/phone/live', subscribeIdentityChange: listener => { changed=listener; return ()=>{}; } });
  connections.push(connection);
  return {connection,authorization,invalidate,changeIdentity:()=>changed()};
}
const tick = () => vi.advanceTimersByTimeAsync(0);
async function open() { await tick(); const socket=Socket.instances.at(-1)!;socket.open();return socket; }
function appState(next: string) { state.currentState=next;for(const listener of state.listeners)listener(next); }
beforeEach(()=>{vi.useFakeTimers();Socket.instances=[];state.currentState='active';state.platform='android';vi.stubGlobal('WebSocket',Socket);});
afterEach(()=>{resetSharedLiveConnection();for(const connection of connections.splice(0))connection.dispose();state.listeners.clear();vi.useRealTimers();vi.unstubAllGlobals();});

describe('the one phone socket',()=>{
  it('the shared production owner supplies and disposes native online events',()=>{
    expect(state.network.size).toBe(0);
    sharedLiveConnection();expect(state.network.size).toBe(1);
    resetSharedLiveConnection();expect(state.network.size).toBe(0);
  });
  it('an embedded connection only uses its supplied host dependencies',()=>{
    const connection=new LiveConnection({authorization:async()=> 'fixture-access',
      liveUrl:()=> 'ws://fixture.invalid/v1/phone/live',subscribeIdentityChange:()=>()=>{}});
    connections.push(connection);expect(state.network.size).toBe(0);
  });
  it('publishes the first failed read without waiting through replacement attempts',async()=>{
    const {connection}=setup();const answer=connection.request('readRoom',{roomId:'a'}).catch(error=>error);
    const socket=await open();socket.drop();await tick();
    expect(useConnectionFailure()).toBe(true);
    expect(await answer).toBeInstanceOf(PhoneSocketDisconnectedError);
    expect(Socket.instances).toHaveLength(1);
  });
  it('network-online invokes the open Room read immediately after a five-second outage',async()=>{
    const {connection}=setup();let answer:Promise<unknown>|undefined;
    await connection.register([{'#h':['a']}],()=>{answer=connection.request('readRoom',{roomId:'a'}).catch(error=>error);});
    const socket=await open();const initial=connection.request('readRoom',{roomId:'a'});socket.reply({room:{id:'a'}});await initial;
    socket.drop();await tick();Socket.instances.at(-1)!.fail();await tick();
    expect(useConnectionFailure()).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    for(const listener of state.network)listener({isConnected:true,isInternetReachable:true});
    const replacement=await open();replacement.reply({room:{id:'a'}});await answer;
    expect(useConnectionFailure()).toBe(false);
    expect(replacement.requests()).toHaveLength(1);
    expect(state.network.size).toBe(1);connection.dispose();expect(state.network.size).toBe(0);
  });
  it('offline signals never invent failures or schedule recovery',async()=>{
    const {connection}=setup();const read=connection.request('readRoom',{roomId:'a'});const socket=await open();socket.reply({});await read;
    const listener=vi.fn();await connection.register([{'#h':['a']}],listener);
    for(const network of state.network)network({isConnected:false,isInternetReachable:false});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(useConnectionFailure()).toBe(false);expect(listener).not.toHaveBeenCalled();expect(Socket.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('browser online invokes the same read and disposal removes its listener',async()=>{
    state.platform='web';const browser=new EventTarget();vi.stubGlobal('window',browser);
    const {connection}=setup();const listener=vi.fn();await connection.register([{'#h':['a']}],listener);await open();
    browser.dispatchEvent(new Event('online'));expect(listener).toHaveBeenCalledTimes(1);
    connection.dispose();browser.dispatchEvent(new Event('online'));expect(listener).toHaveBeenCalledTimes(1);
  });
  it('sends ordinary reads immediately and returns their answers unchanged',async()=>{
    const {connection}=setup();const answer=connection.request('readRoom',{roomId:'a'});const socket=await open();
    expect(socket.protocols).toEqual(['bearer.fixture-access']);expect(socket.requests()[0]).toMatchObject({op:'readRoom',args:{roomId:'a'}});
    const value={room:{id:'a'},messages:[]};socket.reply(value);await expect(answer).resolves.toEqual(value);
  });
  it('shares one connecting socket across concurrent screens and matches reversed replies',async()=>{
    const {connection}=setup();const room=connection.request('readRoom',{roomId:'a'}),workspaces=connection.request('readWorkspaces',{});
    const socket=await open();expect(Socket.instances).toHaveLength(1);socket.reply({workspaces:[]},1);socket.reply({room:{id:'a'}});
    await expect(room).resolves.toEqual({room:{id:'a'}});await expect(workspaces).resolves.toEqual({workspaces:[]});
  });
  it('settles a lost read; the next read reconnects',async()=>{
    const {connection}=setup();const failed=connection.request('readRoom',{roomId:'a'}).catch(error=>error);const first=await open();first.drop();
    expect(await failed).toBeInstanceOf(PhoneSocketDisconnectedError);
    const answer=connection.request('readRoom',{roomId:'a'});
    const second=await open();expect(Socket.instances).toHaveLength(2);expect(second.requests()).toHaveLength(1);second.reply({room:{id:'a'}});
    await expect(answer).resolves.toMatchObject({room:{id:'a'}});
  });
  it('returns a server refusal once and keeps the answered socket usable',async()=>{
    const {connection}=setup();const answer=connection.request('readRoom',{roomId:'a'}).catch(error=>error);
    const socket=await open();socket.refuse();
    expect(await answer).toMatchObject({message:'Read unavailable'});expect(socket.readyState).toBe(1);
    const retried=connection.request('readRoom',{roomId:'a'});socket.reply({room:{id:'a'}},1);await retried;
    expect(Socket.instances).toHaveLength(1);expect(useConnectionFailure()).toBe(false);
  });
  it('a rejected image metadata read cannot disconnect a send awaiting its acknowledgement',async()=>{
    const {connection}=setup();const send=connection.request('sendRoomMessage',{roomId:'a',messageId:'image',text:''});
    const socket=await open();const metadata=connection.request('readMediaMetadata',{objectId:'media'}).catch(error=>error);
    socket.emit({t:'res',id:socket.requests()[1].id,ok:false,error:{code:'unknown_phone_operation',message:'unknown_phone_operation',retryable:false}});
    expect(await metadata).toMatchObject({code:'unknown_phone_operation'});
    expect(socket.readyState).toBe(1);expect(useConnectionFailure()).toBe(false);
    socket.reply({messageId:'image'});await expect(send).resolves.toEqual({messageId:'image'});
    expect(Socket.instances).toHaveLength(1);
  });
  it('settles the first failed native opening without another attempt',async()=>{
    const {connection,invalidate}=setup();const answer=connection.request('readRoom',{roomId:'a'}).catch(error=>error);
    await tick();Socket.instances[0]!.fail();
    expect(await answer).toBeInstanceOf(PhoneSocketDisconnectedError);expect(Socket.instances).toHaveLength(1);expect(invalidate).not.toHaveBeenCalled();
  });
  it('invalidates authorization only for an explicit server authorization refusal',async()=>{
    const {connection,invalidate}=setup();const read=connection.request('readRoom',{roomId:'a'}).catch(error=>error);const socket=await open();
    socket.emit({t:'res',id:socket.requests()[0].id,ok:false,error:{code:'unauthorized',message:'Sign in again',retryable:false}});
    expect(await read).toMatchObject({code:'unauthorized'});expect(invalidate).toHaveBeenCalledWith('fixture-access');
    expect(socket.readyState).toBe(1);expect(Socket.instances).toHaveLength(1);expect(useConnectionFailure()).toBe(false);
  });
  it('does not repeat an authorization failure before any socket request',async()=>{
    const authorization=vi.fn(async()=>{throw Error('Authorization unavailable');});const {connection}=setup(authorization);
    await expect(connection.request('readRoom',{roomId:'a'})).rejects.toThrow('Authorization unavailable');
    expect(authorization).toHaveBeenCalledTimes(1);expect(Socket.instances).toHaveLength(0);
  });
  it('ends an unanswered read at its existing deadline even if pongs arrive',async()=>{
    const {connection}=setup();const answer=connection.request('readRoom',{roomId:'a'},{timeoutMs:100}).catch(error=>error);
    await open();await vi.advanceTimersByTimeAsync(100);
    expect((await answer).constructor.name).toBe('MonolithRequestTimeoutError');expect(Socket.instances).toHaveLength(1);
  });
  it('shares a replacement after two concurrent reads fail together',async()=>{
    const {connection}=setup();const oldRoom=connection.request('readRoom',{roomId:'a'}).catch(error=>error),oldList=connection.request('readWorkspaces',{}).catch(error=>error);
    const first=await open();first.drop();expect(await oldRoom).toBeInstanceOf(PhoneSocketDisconnectedError);expect(await oldList).toBeInstanceOf(PhoneSocketDisconnectedError);
    const room=connection.request('readRoom',{roomId:'a'}),list=connection.request('readWorkspaces',{});
    const replacement=await open();expect(Socket.instances).toHaveLength(2);
    replacement.reply({room:{id:'a'}});replacement.reply({workspaces:[]},1);await room;await list;
  });
  it('does not replay a lost write',async()=>{
    const {connection}=setup();const write=connection.request('reactToMessage',{roomId:'a',messageId:'m',emoji:'👍'}).catch(error=>error);
    const socket=await open();socket.drop();expect(await write).toBeInstanceOf(PhoneSocketDisconnectedError);
    await vi.advanceTimersByTimeAsync(90_000);expect(Socket.instances).toHaveLength(1);expect(socket.requests()).toHaveLength(1);
  });
  it('settles a write at its existing deadline; the next answer clears the banner',async()=>{
    const {connection}=setup();const write=connection.request('reactToMessage',{roomId:'a',messageId:'m',emoji:'👍'},{timeoutMs:100}).catch(error=>error);
    const socket=await open();await vi.advanceTimersByTimeAsync(100);
    expect((await write).constructor.name).toBe('MonolithRequestTimeoutError');expect(useConnectionFailure()).toBe(true);
    expect(Socket.instances).toHaveLength(1);expect(socket.requests()).toHaveLength(1);expect(socket.readyState).toBe(1);
    const read=connection.request('readRoom',{roomId:'a'});socket.reply({room:{id:'a'}},1);await read;
    expect(useConnectionFailure()).toBe(false);
  });
  it('aborts one read without closing another screen’s healthy socket',async()=>{
    const {connection}=setup();const abort=new AbortController();const cancelled=connection.request('readRoom',{roomId:'a'},{signal:abort.signal}).catch(error=>error);
    const socket=await open();const other=connection.request('readWorkspaces',{});abort.abort();expect(await cancelled).toMatchObject({name:'AbortError'});
    socket.reply({workspaces:[]},1);await other;expect(socket.readyState).toBe(1);expect(Socket.instances).toHaveLength(1);
  });
  it('ignores a reply arriving from a replaced socket',async()=>{
    const {connection}=setup();const lost=connection.request('readRoom',{roomId:'a'}).catch(error=>error);const first=await open();first.drop();await lost;
    const answer=connection.request('readRoom',{roomId:'a'});const second=await open();
    first.reply({room:{id:'old'}});second.reply({room:{id:'a'}});await expect(answer).resolves.toEqual({room:{id:'a'}});
  });
  it('never opens with authorization completed after sign-out',async()=>{
    let release!:(token:string)=>void;const authorization=vi.fn(()=>new Promise<string>(resolve=>{release=resolve;}));const {connection,changeIdentity}=setup(authorization);
    await connection.register([],()=>{});changeIdentity();release('old-access');await tick();expect(Socket.instances).toHaveLength(0);
  });
  it('does not retry old-identity reads after sign-out',async()=>{
    const {connection,changeIdentity}=setup();const answer=connection.request('readRoom',{roomId:'a'}).catch(error=>error);await open();changeIdentity();
    expect(await answer).toBeInstanceOf(PhoneSocketDisconnectedError);await tick();expect(Socket.instances).toHaveLength(1);
  });
  it('an old view release cannot hide the new identity’s view',async()=>{
    const {connection,changeIdentity}=setup();await connection.register([],()=>{});await open();const oldRelease=connection.view('a');changeIdentity();
    connection.reconnectNow();const socket=await open();connection.view('a');oldRelease();
    expect(socket.sent.map(value=>JSON.parse(value)).filter(frame=>frame.type==='viewing')).toEqual([{type:'viewing',roomId:'a',viewing:true}]);
  });
  it('subscribes open Rooms without resume cursors and asks the server again for a joining screen',async()=>{
    const {connection}=setup();const listener=vi.fn();const stop=await connection.register([{'#h':['a']}],listener);const socket=await open();
    expect(socket.sent.map(value=>JSON.parse(value))[0]).toEqual({type:'subscribe',roomIds:['a'],sidebarPreviews:true,roomStateProjections:true});
    const other=await connection.register([{'#h':['a']}],()=>{});expect(socket.sent.map(value=>JSON.parse(value)).filter(frame=>frame.type==='subscribe')).toHaveLength(2);
    stop();expect(socket.sent.some(value=>JSON.parse(value).type==='unsubscribe')).toBe(false);other();expect(socket.sent.some(value=>JSON.parse(value).type==='unsubscribe')).toBe(true);
  });
  it('delivers full draft pushes as-is and does not invent a late-join cache',async()=>{
    const {connection}=setup();const first=vi.fn();await connection.register([{'#h':['a']}],first);const socket=await open();
    const event={type:'draft',roomId:'a',agentId:'agent',turnId:'turn',text:'Current text'};socket.emit(event);expect(first).toHaveBeenCalledWith({monolithLive:event});
    const later=vi.fn();await connection.register([{'#h':['a']}],later);expect(later).not.toHaveBeenCalled();socket.emit(event);expect(later).toHaveBeenCalledWith({monolithLive:event});
  });
  it('a broken idle socket asks the screen to invoke its same read',async()=>{
    const {connection}=setup();let read:Promise<unknown>|undefined;await connection.register([{'#h':['a']}],event=>{
      if('monolithLive'in event&&event.monolithLive.type==='invalidate')read=connection.request('readRoom',{roomId:'a'});
    });const first=await open();first.drop();const replacement=await open();replacement.reply({room:{id:'a'}});await read;expect(Socket.instances).toHaveLength(2);
  });
  it('idle time and missing heartbeats cannot close a socket or produce a banner',async()=>{
    const {connection}=setup();const read=connection.request('readRoom',{roomId:'a'});const socket=await open();socket.reply({});await read;
    socket.autoPong=false;await vi.advanceTimersByTimeAsync(3_600_000);
    expect(socket.sent).not.toContain('{"type":"ping"}');expect(socket.readyState).toBe(1);expect(useConnectionFailure()).toBe(false);
    socket.drop();expect(useConnectionFailure()).toBe(false);
  });
  it('foreground asks the screen to read without speculative pings',async()=>{
    const {connection}=setup();const listener=vi.fn();await connection.register([{'#h':['a']}],listener);const socket=await open();appState('background');
    await vi.advanceTimersByTimeAsync(90_000);expect(socket.sent).not.toContain('{"type":"ping"}');appState('active');
    expect(socket.sent).not.toContain('{"type":"ping"}');expect(listener).toHaveBeenCalledWith({monolithLive:{type:'invalidate',roomId:'a',reason:'reconnect'}});
  });
  it('Retry revives a socket already closed before its native close callback arrives',async()=>{
    const {connection}=setup();await connection.register([],()=>{});const first=await open();
    first.readyState=3;connection.reconnectNow();const second=await open();
    expect(second).not.toBe(first);expect(connection.diagnostics().state).toBe(1);
  });
  it('a lost native close callback is handled by the next explicit request',async()=>{
    const {connection}=setup();const listener=vi.fn();await connection.register([],listener);
    const socket=await open();socket.readyState=3;await vi.advanceTimersByTimeAsync(30_000);
    expect(listener).not.toHaveBeenCalled();
    const read=connection.request('readRoom',{roomId:'a'});const next=await open();next.reply({room:{id:'a'}});
    await expect(read).resolves.toMatchObject({room:{id:'a'}});expect(next).not.toBe(socket);expect(useConnectionFailure()).toBe(false);
  });
  it('forwards a native push into the same read without another connection',async()=>{
    const {connection}=setup();const listener=vi.fn();await connection.register([{'#h':['a']}],listener);await open();connection.notePushedMessage('a');
    expect(listener).toHaveBeenCalledWith({monolithLive:{type:'invalidate',roomId:'a',reason:'resync'}});expect(Socket.instances).toHaveLength(1);
  });
});
