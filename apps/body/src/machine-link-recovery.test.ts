import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { DaemonApiClient } from './daemon-api-client.js';
import { MachineLink } from './machine-link.js';

const agentId = 'ab'.repeat(32);
const roomId = '00000000-0000-4000-8000-000000000041';
const commandId = 'cd'.repeat(32);

class Socket extends EventEmitter {
  readyState = 0;
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: string }) => void;
  frames: Record<string, any>[] = [];
  receive(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify({ agentId, ...frame }) });
  }
  send(raw: string) { this.frames.push(JSON.parse(raw)); }
  open() { this.readyState = 1; this.onopen?.(); }
  close() { this.readyState = 3; this.onclose?.(); }
  terminate() { this.close(); }
}
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function fixture() {
  const sockets: Socket[] = [];
  const machine = new MachineLink({
    baseUrl: 'http://synthetic.invalid',
    timing: { heartbeatTimeoutMs: 100 },
    factory: () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });
  const fetcher = vi.fn(async () => { throw new Error('unexpected HTTP fallback'); });
  const api = new DaemonApiClient('http://synthetic.invalid', 'token', agentId,
    fetcher, undefined, undefined, undefined, machine);
  cleanups.push(() => api.closeLive());
  const claimed: string[] = [];
  api.liveSubscribe(roomId, undefined, undefined, undefined, undefined, commands => {
    for (const command of commands) {
      void api.execute('claimAgentCommand', { roomId, commandId: command.id, generationId: '00000000-0000-4000-8000-000000000042' })
        .then(() => claimed.push(command.id));
    }
  });
  const register = (socket: Socket) => {
    socket.open();
    socket.receive({ type: 'registered', capabilities: { daemonOperationsV1: true, initialSnapshotsV1: true, intakeHeartbeat: true, turnOwnershipV1: true, turnConnectionId: 'connection', turnConnectionEpoch: 1 } });
  };
  return { sockets, machine, api, fetcher, claimed, register };
}

it('reconnects through initial and repeated socket losses, reads current commands and claims again', async () => {
  const { sockets, register, claimed, fetcher } = fixture();
  // Neither the first failed handshake nor another failed replacement may park.
  sockets[0]!.close();
  sockets[1]!.close();
  expect(sockets).toHaveLength(3);
  register(sockets[2]!);
  sockets[2]!.close(); // loss before initial snapshots are complete
  expect(sockets).toHaveLength(4);
  const recovered = sockets[3]!;
  register(recovered);
  const subscription = recovered.frames.find(frame => frame.type === 'subscribe');
  expect(subscription).toMatchObject({ roomId });
  recovered.receive({ type: 'commands', roomId, requestId: subscription!.requestId, commandProtocol: 1, commands: [{
    id: commandId, roomId, agentId, action: 'input', reason: 'human_tag',
    sourceMessageId: 'message', turnRequestId: commandId, rootCommandId: commandId, rootSourceMessageId: 'message', agentDepth: 0,
    source: { id: 'message', authorId: 'human', body: '@ruby respond', createdAt: Date.now(), attachments: [] },
  }] });
  await vi.waitFor(() => expect(recovered.frames.some(frame => frame.operation === 'claimAgentCommand')).toBe(true));
  const claim = recovered.frames.find(frame => frame.operation === 'claimAgentCommand')!;
  recovered.receive({ type: 'turn-result', requestId: claim.requestId, result: { id: commandId, createdAt: Date.now() } });
  await vi.waitFor(() => expect(claimed).toEqual([commandId]));
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(['registration', 'initial snapshots', 'intake heartbeat'])('reconnects when %s stops responding', async stage => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const { sockets, machine, register } = fixture();
  const socket = sockets[0]!;
  if (stage === 'registration') socket.open();
  else register(socket);
  if (stage === 'intake heartbeat') {
    const subscription = socket.frames.find(frame => frame.type === 'subscribe')!;
    socket.receive({ type: 'commands', roomId, requestId: subscription.requestId, commandProtocol: 1, commands: [] });
    socket.receive({ type: 'subscribed', roomId, requestId: subscription.requestId, capabilities: { inboxSnapshot: false, initialSnapshotsV1: true } });
  }
  // A living transport cannot conceal stalled agent intake.
  await vi.advanceTimersByTimeAsync(50);
  socket.emit('ping');
  await vi.advanceTimersByTimeAsync(50);
  expect(sockets).toHaveLength(2);
  expect(machine.link.state).toBe('connecting');
  register(sockets[1]!);
  expect(sockets[1]!.frames.some(frame => frame.type === 'subscribe')).toBe(true);
});

it('re-registers after repeated server drops before catch-up completes', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const { sockets, register } = fixture();
  const socket = sockets[0]!;
  register(socket);
  for (let i = 0; i < 3; i++) {
    socket.receive({ type: 'unregistered', reason: 'live request failed' });
    socket.receive({ type: 'registered', capabilities: {} });
  }
  expect(socket.frames.filter(frame => frame.type === 'register')).toHaveLength(4);
});

it.each(['registration_failed', 'too_many_agents'])('reconnects %s but retains settled credential refusal and explicit stop', code => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const { sockets, machine, api } = fixture();
  sockets[0]!.open();
  sockets[0]!.receive({ type: 'register-refused', code });
  expect(sockets).toHaveLength(2);
  sockets[1]!.open();
  sockets[1]!.receive({ type: 'register-refused', code: 'agent_removed' });
  expect(sockets).toHaveLength(2);
  expect(machine.link.state).toBe('disconnected');
  api.closeLive();
  expect(sockets).toHaveLength(2);
});

it('does not reopen an explicitly stopped machine or a required-update connection', () => {
  const stopped = fixture();
  stopped.register(stopped.sockets[0]!);
  stopped.api.closeLive();
  stopped.sockets[0]!.close();
  expect(stopped.sockets).toHaveLength(1);

  const updating = fixture();
  updating.register(updating.sockets[0]!);
  updating.sockets[0]!.receive({ type: 'force-update', minVersion: 'v999.0.0' });
  updating.sockets[0]!.close();
  expect(updating.sockets).toHaveLength(1);
  expect(updating.machine.link.state).toBe('update-required');
});
