import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonApiClient, type DaemonWebSocketFactory } from './daemon-api-client.js';

const agentId = 'a'.repeat(64);
class Socket extends EventEmitter {
  readyState = 0;
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: {data:string}) => void;
  readonly frames: Record<string, any>[] = [];
  constructor(readonly currentServer: boolean, readonly autoRegister = true) { super(); }
  receive(frame: Record<string, unknown>) {
    this.onmessage?.({data:JSON.stringify({agentId, ...frame})});
  }
  send(raw: string) {
    const frame = JSON.parse(raw); this.frames.push(frame);
    if (frame.type === 'register' && this.autoRegister && this.registrations().length <= 4)
      this.receive({type:'registered', capabilities:{initialSnapshotsV1:this.currentServer, intakeHeartbeat:false}});
  }
  registrations() { return this.frames.filter(frame => frame.type === 'register'); }
  subscriptions() { return this.frames.filter(frame => frame.type === 'subscribe'); }
  terminate() { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.(); }
  close() { this.terminate(); }
}
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(release => release()); vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture(currentServer = true, withInbox = false, autoRegister = true) {
  const socket = new Socket(currentServer, autoRegister);
  const fetcher = vi.fn(async () => { throw new Error('No HTTP recovery is admitted'); });
  const api = new DaemonApiClient('http://synthetic.invalid', 'bdt_synthetic', agentId, fetcher,
    (() => socket as unknown as WebSocket) as DaemonWebSocketFactory);
  cleanup.push(() => api.closeLive());
  const state = vi.fn(), items = vi.fn();
  const release = api.liveSubscribe('room', undefined, withInbox ? items : undefined, state);
  socket.readyState = 1; socket.onopen?.();
  const recovered = vi.spyOn(api.link, 'markRecovered');
  const controls = (requestId = socket.subscriptions().at(-1)!.requestId, inboxSnapshot = withInbox) =>
    socket.receive({type:'subscribed', roomId:'room', ...(currentServer ? {requestId} : {}),
      capabilities:{pushIntake:true, initialSnapshotsV1:currentServer, inboxSnapshot}});
  const commands = (requestId = socket.subscriptions().at(-1)!.requestId) =>
    socket.receive({type:'commands', roomId:'room', ...(currentServer ? {requestId} : {}), commandProtocol:1, commands:[]});
  const inbox = (requestId = socket.subscriptions().at(-1)!.requestId) =>
    socket.receive({type:'inbox', roomId:'room', ...(currentServer ? {requestId} : {}), items:[]});
  return {api, socket, fetcher, state, items, release, recovered, controls, commands, inbox};
}

describe('initial demanded snapshot recovery', () => {
  it('allows at most one incident replacement; repeated successful controls without initial data park for 24h', async () => {
    vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const f = fixture(); f.controls();
    expect(f.state).not.toHaveBeenCalled(); expect(f.recovered).not.toHaveBeenCalled();
    f.commands(); expect(f.state).toHaveBeenCalledOnce(); expect(f.recovered).toHaveBeenCalledOnce();
    f.socket.receive({type:'unregistered', reason:'initial projection incident'});
    expect(f.socket.registrations()).toHaveLength(2);
    f.controls(); f.controls(); // Neither registered nor subscribed proves catch-up.
    f.socket.receive({type:'unregistered', reason:'inbox replay failed'});
    const admitted = f.socket.frames.length;
    const heartbeat = setInterval(() => { f.socket.emit('ping'); f.socket.receive({type:'intake-ready'}); }, 30_000);
    cleanup.push(() => clearInterval(heartbeat));
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(f.socket.registrations()).toHaveLength(2); expect(f.socket.subscriptions()).toHaveLength(2);
    expect(f.socket.frames).toHaveLength(admitted); expect(f.recovered).toHaveBeenCalledOnce();
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('requires every demanded lane even when the server sends acknowledgement first', () => {
    const f = fixture(true, true); f.controls(); f.commands();
    expect(f.state).not.toHaveBeenCalled();
    f.inbox(); expect(f.state).toHaveBeenCalledOnce(); expect(f.recovered).toHaveBeenCalledOnce();
    f.controls(); f.commands(); f.inbox(); expect(f.state).toHaveBeenCalledOnce();
    expect(f.items).not.toHaveBeenCalled(); // A valid empty snapshot still completes the lane.
  });

  it('waits for a real legacy empty inbox when an old server does not echo inbox:false', () => {
    const f = fixture(false); expect(f.socket.subscriptions()[0]).toMatchObject({inbox:false});
    f.controls(); f.commands(); expect(f.state).not.toHaveBeenCalled();
    f.inbox(); expect(f.state).toHaveBeenCalledOnce(); expect(f.recovered).toHaveBeenCalledOnce();
  });

  it('rejects an old subscription closure and missing current-server correlation after demand changes', () => {
    const f = fixture(); f.api.setRoomsChangedListener(() => undefined);
    const oldId = f.socket.subscriptions()[0]!.requestId;
    f.release();
    const newer = vi.fn(); f.api.liveSubscribe('room', undefined, undefined, newer);
    expect(f.socket.subscriptions()).toHaveLength(2);
    const newId = f.socket.subscriptions()[1]!.requestId; expect(newId).not.toBe(oldId);
    f.controls(oldId); f.commands(oldId); f.inbox(oldId);
    f.socket.receive({type:'subscribed', roomId:'room', capabilities:{initialSnapshotsV1:true, inboxSnapshot:false}});
    f.socket.receive({type:'commands', roomId:'room', commandProtocol:1, commands:[]});
    expect(newer).not.toHaveBeenCalled();
    const recoveredBefore = f.recovered.mock.calls.length;
    f.controls(newId); f.commands(newId);
    expect(newer).toHaveBeenCalledOnce(); expect(f.recovered).toHaveBeenCalledTimes(recoveredBefore + 1);
  });

  it('uses one initial barrier deadline that transport and intake controls cannot renew', async () => {
    vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const f = fixture(); f.controls();
    const heartbeat = setInterval(() => { f.socket.emit('ping'); f.socket.receive({type:'intake-ready'}); f.controls(); }, 30_000);
    cleanup.push(() => clearInterval(heartbeat));
    await vi.advanceTimersByTimeAsync(76_000);
    expect(f.socket.frames.filter(frame => frame.type === 'unregister')).toHaveLength(1);
    f.commands(); expect(f.state.mock.calls.some(([connected]) => connected)).toBe(false);
    const frames = f.socket.frames.length;
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(f.socket.frames).toHaveLength(frames); expect(f.socket.registrations()).toHaveLength(1);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('cannot resurrect a registration that completes after its admitted deadline', async () => {
    vi.useFakeTimers(); vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const f = fixture(true, false, false);
    const heartbeat = setInterval(() => f.socket.emit('ping'), 30_000);
    cleanup.push(() => clearInterval(heartbeat));
    await vi.advanceTimersByTimeAsync(76_000);
    f.socket.receive({type:'registered', capabilities:{initialSnapshotsV1:true}});
    expect(f.socket.subscriptions()).toHaveLength(0);
    expect(f.socket.frames.filter(frame => frame.type === 'unregister')).toHaveLength(1);
    expect(f.state).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  });
});
