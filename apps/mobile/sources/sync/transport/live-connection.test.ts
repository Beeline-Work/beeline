import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ currentState: 'active', listeners: new Set<(value: string) => void>() }));
vi.mock('react-native', () => ({ AppState: { get currentState() { return state.currentState; },
  addEventListener: (_event: string, listener: (value: string) => void) => {
    state.listeners.add(listener); return { remove: () => state.listeners.delete(listener) };
  } } }));
vi.mock('@/auth/monolith-session', () => ({
  MonolithRequestTimeoutError: class MonolithRequestTimeoutError extends Error {},
  MonolithSessionChangedError: class MonolithSessionChangedError extends Error {},
  monolithSession: { authorization: async () => 'fixture-access', invalidateAuthorization: vi.fn() },
}));
import { LiveConnection } from './live-connection';
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
    liveUrl:()=> 'ws://fixture.invalid/v1/phone/live', subscribeIdentityChange: listener => { changed=listener; return ()=>{}; } });
  connections.push(connection);
  return {connection,authorization,invalidate,changeIdentity:()=>changed()};
}
const tick = () => vi.advanceTimersByTimeAsync(0);
async function open() { await tick(); const socket=Socket.instances.at(-1)!;socket.open();return socket; }
function appState(next: string) { state.currentState=next;for(const listener of state.listeners)listener(next); }
beforeEach(()=>{vi.useFakeTimers();Socket.instances=[];state.currentState='active';vi.stubGlobal('WebSocket',Socket);});
afterEach(()=>{for(const connection of connections.splice(0))connection.dispose();state.listeners.clear();vi.useRealTimers();vi.unstubAllGlobals();});

describe('the one phone socket',()=>{
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
  it('reconnects and reads again when the socket dies during a read',async()=>{
    const {connection}=setup();const answer=connection.request('readRoom',{roomId:'a'});const first=await open();first.drop();
    const second=await open();expect(Socket.instances).toHaveLength(2);expect(second.requests()).toHaveLength(1);second.reply({room:{id:'a'}});
    await expect(answer).resolves.toMatchObject({room:{id:'a'}});
  });
  it('stops after three server failures; Retry starts a fresh three-attempt read',async()=>{
    const {connection}=setup();const answer=connection.request('readRoom',{roomId:'a'}).catch(error=>error);
    for(let n=0;n<3;n++){const socket=await open();socket.refuse();}
    expect(await answer).toMatchObject({message:'Read unavailable'});await tick();expect(Socket.instances).toHaveLength(3);
    const retried=connection.request('readRoom',{roomId:'a'});const socket=await open();socket.reply({room:{id:'a'}});await expect(retried).resolves.toMatchObject({room:{id:'a'}});
    expect(Socket.instances).toHaveLength(4);
  });
  it('counts failed native openings against the same three attempts',async()=>{
    const {connection,invalidate}=setup();const answer=connection.request('readRoom',{roomId:'a'}).catch(error=>error);
    for(let n=0;n<3;n++){await tick();Socket.instances[n]!.fail();}
    expect(await answer).toBeInstanceOf(PhoneSocketDisconnectedError);expect(Socket.instances).toHaveLength(3);expect(invalidate).toHaveBeenCalledTimes(3);
  });
  it('counts authorization failures against the same three attempts',async()=>{
    const authorization=vi.fn(async()=>{throw Error('Authorization unavailable');});const {connection}=setup(authorization);
    await expect(connection.request('readRoom',{roomId:'a'})).rejects.toThrow('Authorization unavailable');
    expect(authorization).toHaveBeenCalledTimes(3);expect(Socket.instances).toHaveLength(0);
  });
  it('ends an unanswered read at its existing deadline even if pongs arrive',async()=>{
    const {connection}=setup();const answer=connection.request('readRoom',{roomId:'a'},{timeoutMs:100}).catch(error=>error);
    for(let n=0;n<3;n++){await open();await vi.advanceTimersByTimeAsync(100);}
    expect((await answer).constructor.name).toBe('MonolithRequestTimeoutError');expect(Socket.instances).toHaveLength(3);
  });
  it('shares a replacement after two concurrent reads fail together',async()=>{
    const {connection}=setup();const room=connection.request('readRoom',{roomId:'a'}),list=connection.request('readWorkspaces',{});
    const first=await open();first.drop();const replacement=await open();expect(Socket.instances).toHaveLength(2);
    replacement.reply({room:{id:'a'}});replacement.reply({workspaces:[]},1);await room;await list;
  });
  it('does not replay a lost write',async()=>{
    const {connection}=setup();const write=connection.request('reactToMessage',{roomId:'a',messageId:'m',emoji:'👍'}).catch(error=>error);
    const socket=await open();socket.drop();expect(await write).toBeInstanceOf(PhoneSocketDisconnectedError);
    await vi.advanceTimersByTimeAsync(90_000);expect(Socket.instances).toHaveLength(1);expect(socket.requests()).toHaveLength(1);
  });
  it('a healthy slow write keeps waiting for its result without replay',async()=>{
    const {connection}=setup();const write=connection.request('reactToMessage',{roomId:'a',messageId:'m',emoji:'👍'},{timeoutMs:100});
    const socket=await open();await vi.advanceTimersByTimeAsync(200);expect(Socket.instances).toHaveLength(1);expect(socket.requests()).toHaveLength(1);
    socket.reply({});await write;
  });
  it('aborts one read without closing another screen’s healthy socket',async()=>{
    const {connection}=setup();const abort=new AbortController();const cancelled=connection.request('readRoom',{roomId:'a'},{signal:abort.signal}).catch(error=>error);
    const socket=await open();const other=connection.request('readWorkspaces',{});abort.abort();expect(await cancelled).toMatchObject({name:'AbortError'});
    socket.reply({workspaces:[]},1);await other;expect(socket.readyState).toBe(1);expect(Socket.instances).toHaveLength(1);
  });
  it('ignores a reply arriving from a replaced socket',async()=>{
    const {connection}=setup();const answer=connection.request('readRoom',{roomId:'a'});const first=await open();first.drop();const second=await open();
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
  it('checks foreground liveness after 30 seconds and keeps a socket that answers',async()=>{
    const {connection}=setup();await connection.register([],()=>{});const socket=await open();await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.sent).toContain('{"type":"ping"}');expect(socket.readyState).toBe(1);expect(Socket.instances).toHaveLength(1);
  });
  it('a missing heartbeat pong asks open screens to read and reconnect',async()=>{
    const {connection}=setup();let read:Promise<unknown>|undefined;await connection.register([{'#h':['a']}],event=>{
      if('monolithLive'in event&&event.monolithLive.type==='invalidate')read=connection.request('readRoom',{roomId:'a'});
    });const socket=await open();socket.autoPong=false;await vi.advanceTimersByTimeAsync(35_000);const replacement=await open();replacement.reply({room:{id:'a'}});await read;
    expect(Socket.instances).toHaveLength(2);
  });
  it('sends no background heartbeat and checks/read-refreshes on foreground',async()=>{
    const {connection}=setup();const listener=vi.fn();await connection.register([{'#h':['a']}],listener);const socket=await open();appState('background');
    await vi.advanceTimersByTimeAsync(90_000);expect(socket.sent).not.toContain('{"type":"ping"}');appState('active');
    expect(socket.sent).toContain('{"type":"ping"}');expect(listener).toHaveBeenCalledWith({monolithLive:{type:'invalidate',roomId:'a',reason:'reconnect'}});
  });
  it('Retry revives a socket already closed before its native close callback arrives',async()=>{
    const {connection}=setup();await connection.register([],()=>{});const first=await open();
    first.readyState=3;connection.reconnectNow();const second=await open();
    expect(second).not.toBe(first);expect(connection.diagnostics().state).toBe(1);
  });
  it('the heartbeat detects native closure even if its callback was lost',async()=>{
    const {connection}=setup();const listener=vi.fn();await connection.register([{'#h':['a']}],listener);
    const socket=await open();socket.readyState=3;await vi.advanceTimersByTimeAsync(30_000);
    expect(listener).toHaveBeenCalledWith({monolithLive:{type:'invalidate',roomId:'a',reason:'reconnect'}});
  });
  it('forwards a native push into the same read without another connection',async()=>{
    const {connection}=setup();const listener=vi.fn();await connection.register([{'#h':['a']}],listener);await open();connection.notePushedMessage('a');
    expect(listener).toHaveBeenCalledWith({monolithLive:{type:'invalidate',roomId:'a',reason:'resync'}});expect(Socket.instances).toHaveLength(1);
  });
});
