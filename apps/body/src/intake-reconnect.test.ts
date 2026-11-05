import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import type WebSocket from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { DaemonApiClient } from './daemon-api-client.js';
import { MachineLink } from './machine-link.js';
import { RoomSupervisor } from './room-supervisor.js';
import { CommandExecutionContext, runServerCommandIntake } from './server-command-intake.js';

const agentId = 'ab'.repeat(32);
const places = Array.from({ length: 24 }, (_, i) => `${i < 12 ? 'room' : 'corner'}-${i}`);

class Socket extends EventEmitter {
  readyState = 0;
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: string }) => void;
  frames: Record<string, any>[] = [];
  holdReads = false;
  receive(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify({ agentId, ...frame }) });
  }
  send(raw: string) {
    const frame = JSON.parse(raw);
    this.frames.push(frame);
    if(frame.type==='request-result')this.receive({type:'request-missing',requestId:frame.requestId});
    if (frame.type === 'daemon-operation' && !this.holdReads)
      this.receive({ type: 'daemon-operation-result', requestId: frame.requestId,
        result: { commandProtocol: 1, commands: [] } });
    if (frame.type === 'subscribe') {
      this.receive({ type: 'commands', roomId: frame.roomId, requestId: frame.requestId,
        commandProtocol: 1, commands: [] });
      this.receive({ type: 'subscribed', roomId: frame.roomId, requestId: frame.requestId,
        capabilities: { pushIntake: true, inboxSnapshot: false, initialSnapshotsV1: true } });
    }
  }
  open() { this.readyState = 1; this.onopen?.(); }
  register() {
    this.receive({ type: 'registered', capabilities: { daemonOperationsV1: true, initialSnapshotsV1: true } });
  }
  close() { this.readyState = 3; this.onclose?.(); }
  terminate() { this.close(); }
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

function fixture() {
  const sockets: Socket[] = [];
  const machine = new MachineLink({ baseUrl: 'http://synthetic.invalid', factory: () => {
    const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket;
  } });
  const fetcher = vi.fn(async () => { throw new Error('unexpected HTTP fallback'); });
  const api = new DaemonApiClient('http://synthetic.invalid', 'token', agentId,
    fetcher, undefined, undefined, undefined, machine);
  const supervisor = new RoomSupervisor(api);
  const controller = new AbortController();
  const connected = new Set<string>();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const running = places.map(roomId => supervisor.supervise(roomId, controller.signal, () =>
    runServerCommandIntake({ api, roomId, agentId, signal: controller.signal,
      context: new CommandExecutionContext(), run: async () => undefined, stop: () => undefined,
      onSubscriptionState: open => { if (open) connected.add(roomId); else connected.delete(roomId); },
    })));
  cleanups.push(async () => { controller.abort(); api.closeLive(); await Promise.all(running); });
  return { api, sockets, connected, fetcher, errors };
}

it.each([0, 2])('restores all 12 Rooms and 12 corners after startup read loss and %i failed handshakes', async failedHandshakes => {
  const { sockets, connected, fetcher, errors } = fixture();
  const first = sockets[0]!;
  first.holdReads = true;
  first.open();
  await setImmediate();
  expect(first.frames.every(frame => frame.type === 'register-machine')).toBe(true);
  first.register();
  await setImmediate();
  expect(first.frames.filter(frame => frame.operation === 'getAgentCommands')).toHaveLength(24);
  first.close();
  await setImmediate();
  for (let i = 0; i < failedHandshakes; i++) { sockets.at(-1)!.close(); await Promise.resolve(); }
  expect(sockets).toHaveLength(2 + failedHandshakes);
  const successor = sockets.at(-1)!;
  successor.open();
  await setImmediate();
  expect(connected.size).toBe(0);
  expect(successor.frames.every(frame => frame.type === 'register-machine')).toBe(true);
  successor.register();
  await setImmediate();
  expect([...connected].sort()).toEqual([...places].sort());
  expect(successor.frames.filter(frame => frame.operation === 'getAgentCommands')).toHaveLength(24);
  expect(errors.mock.calls.some(call => String(call[0]).includes('waiting for'))).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
});

it('waits after a failed intake read until an actual close opens its successor', async () => {
  const { sockets, connected, fetcher } = fixture();
  const first = sockets[0]!;
  first.holdReads = true;
  first.open(); first.register();
  await setImmediate();
  const requests = first.frames.filter(frame => frame.operation === 'getAgentCommands');
  for (const frame of requests)
    first.receive({ type: 'daemon-operation-result', requestId: frame.requestId, error: 'unavailable', status: 503 });
  await setImmediate();
  expect(sockets).toHaveLength(1);
  first.close();await setImmediate();
  sockets[1]!.open(); sockets[1]!.register();
  await setImmediate();
  expect(connected.size).toBe(24);
  expect(sockets).toHaveLength(2);
  for (const roomId of places)
    expect(sockets[1]!.frames.filter(frame => frame.operation === 'getAgentCommands' && frame.input.roomId === roomId)).toHaveLength(1);
  expect(fetcher).not.toHaveBeenCalled();
});

it('awaits re-registration before dispatching a previously selected ordinary operation', async () => {
  const { api, sockets } = fixture();
  sockets[0]!.open(); sockets[0]!.register();
  await setImmediate();
  sockets[0]!.close();
  const settled = vi.fn();
  const read = api.execute('getAgentCommands', { roomId: places[0]! });
  void read.then(settled, settled);
  await setImmediate();
  expect(settled).not.toHaveBeenCalled();
  const successor = sockets[1]!;
  successor.open();
  await setImmediate();
  expect(settled).not.toHaveBeenCalled();
  expect(successor.frames.every(frame => frame.type === 'register-machine')).toBe(true);
  successor.register();
  await expect(read).resolves.toEqual({ commandProtocol: 1, commands: [] });
});
