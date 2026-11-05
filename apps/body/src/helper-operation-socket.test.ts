import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { DaemonApiClient, type DaemonWebSocketFactory } from './daemon-api-client.js';
import type { AgentChannel } from './machine-link.js';
import type { HostReadBudget } from './host-read-budget.js';
import { LIVE_LINK_TIMING } from './live-link.js';


class Socket extends EventEmitter {
  readyState = 0;
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: {data: string}) => void;
  frames: Record<string, any>[] = [];
  hold = false;
  registerReplies = true;
  constructor(public capable: boolean) { super(); }
  receive(frame: Record<string, unknown>) {
    this.onmessage?.({data: JSON.stringify({agentId: 'agent', ...frame})});
  }
  send(raw: string) {
    const frame = JSON.parse(raw); this.frames.push(frame);
    if (frame.type === 'register' && this.registerReplies) this.receive({type: 'registered', capabilities: this.capable ? {daemonOperationsV1: true} : {}});
    if (frame.type === 'daemon-operation' && !this.hold)
      this.receive({type: 'daemon-operation-result', requestId: frame.requestId, result: {id: frame.operation, createdAt: 1}});
  }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.(); }
  terminate() { this.close(); }
}
const cleanups: (() => void)[] = [];
afterEach(() => { for (const release of cleanups.splice(0)) release(); vi.useRealTimers(); });
function fixture(capable = true, readBudget?: HostReadBudget) {
  const socket = new Socket(capable);
  const fetcher = vi.fn(async () => Response.json({id: 'http', createdAt: 1}));
  const api = new DaemonApiClient('http://synthetic.invalid', 'token', 'agent', fetcher,
    (() => socket as unknown as WebSocket) as DaemonWebSocketFactory, readBudget);
  cleanups.push(() => api.closeLive());
  return {api, socket, fetcher};
}

it('keeps only pre-registration bootstrap on HTTP; registers before every other operation family', async () => {
  const {api, socket, fetcher} = fixture();
  await api.execute('getDaemonBootstrap', {agentId: 'agent'});
  expect(fetcher).toHaveBeenCalledOnce();
  const read = api.execute('getAgentConfiguration', {agentId: 'agent'});
  expect(fetcher).toHaveBeenCalledOnce(); socket.open();
  await expect(read).resolves.toMatchObject({id: 'getAgentConfiguration'});
  await api.execute('getDaemonBootstrap', {agentId: 'agent'});
  await api.execute('listRooms', {agentId: 'agent'});
  await api.execute('postRoomMessage', {roomId: 'room', requestId: 'request', generationId: 'generation', text: 'hello'});
  await api.execute('getWalletToolBalance', {roomId: 'room'});
  expect(socket.frames.filter(frame => frame.type === 'daemon-operation').map(frame => frame.operation))
    .toEqual(['getAgentConfiguration', 'getDaemonBootstrap', 'listRooms', 'postRoomMessage', 'getWalletToolBalance']);
  expect(fetcher).toHaveBeenCalledOnce();
});
it('retains HTTP only for an actually registered old server', async () => {
  const {api, socket, fetcher} = fixture(false);
  const read = api.execute('getAgentConfiguration', {agentId: 'agent'});
  expect(fetcher).not.toHaveBeenCalled(); socket.open();
  await expect(read).resolves.toMatchObject({id: 'http'});
  expect(fetcher).toHaveBeenCalledOnce();
  expect(socket.frames.some(frame => frame.type === 'daemon-operation')).toBe(false);
});
it.each(['deadline', 'disconnect'] as const)('keeps sent effects UNKNOWN after %s with zero HTTP or automatic replay', async cause => {
  vi.useFakeTimers();
  const {api, socket, fetcher} = fixture(); socket.hold = true;
  const request = api.execute('postRoomMessage', {roomId: 'room', requestId: 'request', generationId: 'generation', text: 'hello'});
  socket.open(); await vi.advanceTimersByTimeAsync(0);
  const settled = request.catch(error => error);
  if (cause === 'deadline') await vi.advanceTimersByTimeAsync(30_000);
  else api.closeLive();
  expect(await settled).toMatchObject(cause === 'deadline'
    ? {status: 408, code: 'deadline_exceeded'} : {status: 503, code: 'outcome_unknown'});
  expect(api.metrics().timeouts).toBe(cause === 'deadline' ? 1 : 0);
  expect(socket.frames.filter(frame => frame.type === 'daemon-operation')).toHaveLength(1);
  api.closeLive();
  await expect(api.execute('getAgentConfiguration', {agentId: 'agent'})).rejects.toThrow('registration unavailable');
  expect(fetcher).not.toHaveBeenCalled();
});
it('correlates concurrent results and preserves settled refusal statuses', async () => {
  const {api, socket, fetcher} = fixture(); socket.hold = true;
  const first = api.execute('getAgentConfiguration', {agentId: 'agent'});
  socket.open(); await Promise.resolve(); await Promise.resolve();
  const second = api.execute('getAgentUsage', {agentId: 'agent'});
  await Promise.resolve(); await Promise.resolve();
  await vi.waitFor(() => expect(socket.frames.filter(frame => frame.type === 'daemon-operation')).toHaveLength(2));
  const requests = socket.frames.filter(frame => frame.type === 'daemon-operation');
  socket.receive({type: 'daemon-operation-result', requestId: requests[1]!.requestId, result: {id: 'second'}});
  socket.receive({type: 'daemon-operation-result', requestId: requests[0]!.requestId, error: 'access denied', status: 403});
  await expect(first).rejects.toMatchObject({status: 403, retryable: false});
  await expect(second).resolves.toMatchObject({id: 'second'});
  expect(fetcher).not.toHaveBeenCalled();
});
it('retains definitive removed-agent evidence after machine selection without reopening HTTP', async () => {
  const {api, socket, fetcher} = fixture();
  const ready = api.execute('getAgentConfiguration', {agentId: 'agent'}); socket.open(); await ready;
  socket.receive({type: 'register-refused', code: 'agent_removed'});
  await expect(api.execute('getDaemonBootstrap', {agentId: 'agent'})).rejects.toMatchObject({status: 403, code: 'agent_removed', retryable: false});
  expect(fetcher).not.toHaveBeenCalled();
});

it('parks a previously selected channel when re-registration lacks the capability', async () => {
  const {api, socket, fetcher} = fixture();
  const ready = api.execute('getAgentConfiguration', {agentId: 'agent'}); socket.open(); await ready;
  socket.capable = false;
  const internal = api.channel as AgentChannel; // Host lifecycle seam for this transport proof only.
  internal.socketClosed();
  internal.register();
  await expect(api.execute('getAgentConfiguration', {agentId: 'agent'})).rejects.toThrow('UNKNOWN');
  expect(fetcher).not.toHaveBeenCalled();
  expect(socket.frames.filter(frame => frame.type === 'daemon-operation')).toHaveLength(1);
});

it('uses the registration deadline to reconnect and resume machine operations without HTTP', async () => {
  vi.useFakeTimers();
  const {api, socket, fetcher} = fixture(); socket.registerReplies = false;
  let settled = false;
  const first = api.execute('getAgentConfiguration', {agentId: 'agent'}).finally(()=>{settled=true;});
  socket.open();
  await vi.advanceTimersByTimeAsync(LIVE_LINK_TIMING.heartbeatTimeoutMs / 2);
  socket.emit('ping');
  await vi.advanceTimersByTimeAsync(LIVE_LINK_TIMING.heartbeatTimeoutMs / 2);
  expect(settled).toBe(false);
  socket.registerReplies = true;
  socket.open();
  await expect(first).resolves.toMatchObject({id:'getAgentConfiguration'});
  await expect(api.execute('getAgentConfiguration', {agentId: 'agent'})).resolves.toMatchObject({id: 'getAgentConfiguration'});
  expect(fetcher).not.toHaveBeenCalled();
  expect(socket.frames.filter(frame => frame.type === 'register')).toHaveLength(2);
});
it('sends selected machine reads even when the old HTTP read budget is full', async () => {
  const acquire = vi.fn(async () => { throw new Error('HTTP budget full'); });
  const {api, socket, fetcher} = fixture(true, {acquire} as unknown as HostReadBudget);
  const read = api.execute('getAgentConfiguration', {agentId: 'agent'}); socket.open();
  await expect(read).resolves.toMatchObject({id: 'getAgentConfiguration'});
  expect(acquire).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});
