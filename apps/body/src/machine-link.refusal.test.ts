import { afterEach, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { AgentChannel, MachineLink } from './machine-link.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it.each(['daemon_token_required', 'agent_removed', 'too_many_agents'])(
  'logs %s once and does not retry it across hours or socket reconnects', async (code) => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const send = vi.fn(() => true);
    const machine = { link: { isOpen: () => true, send }, want: vi.fn(), unwant: vi.fn(), random: () => 1,
      registered: vi.fn() } as unknown as MachineLink;
    const refused = vi.fn();
    const handlers = { registration: () => ({ token: 'bdt_revoked' }), onOpen: vi.fn(),
      onClose: vi.fn(), onMessage: vi.fn(), onRefused: refused, onUpdateRequired: vi.fn() };
    const channel = new AgentChannel(machine, 'a'.repeat(64), handlers);
    channel.start(); channel.register();
    channel.receive({ type: 'register-refused', code });
    await vi.advanceTimersByTimeAsync(4 * 60 * 60_000);
    channel.socketClosed(); channel.start(); channel.register();
    channel.receive({ type: 'register-refused', code });
    expect(send).toHaveBeenCalledTimes(1);
    expect(refused).toHaveBeenCalledTimes(1);
    expect(machine.unwant).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    // Restoring through pairing creates a new channel, which can register.
    const restored = new AgentChannel(machine, 'a'.repeat(64), handlers);
    restored.start(); restored.register();
    expect(send).toHaveBeenCalledTimes(2);
    restored.stop(); channel.stop();
  },
);

it('keeps bounded backoff for a transient registration failure', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const send = vi.fn(() => true);
  const machine = { link: { isOpen: () => true, send }, want: vi.fn(), unwant: vi.fn(), random: () => 1 } as unknown as MachineLink;
  const channel = new AgentChannel(machine, 'a'.repeat(64), {
    registration: () => ({ token: 'bdt_valid' }), onOpen: vi.fn(), onClose: vi.fn(),
    onMessage: vi.fn(), onUpdateRequired: vi.fn(),
  });
  channel.start(); channel.register();
  channel.receive({ type: 'register-refused', code: 'registration_failed' });
  await vi.advanceTimersByTimeAsync(999);
  expect(send).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(send).toHaveBeenCalledTimes(2);
  channel.stop();
});

it.each([false, true])('a permanent refusal stops the socket only when no sibling needs it (sibling=%s)', async sibling => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const listeners = new Map<string, () => void>();
  const socket: { readyState: number; onopen?: () => void; onclose?: () => void;
    onmessage?: (event: { data: string }) => void; send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn>;
    on: (name: string, listener: () => void) => void } = {
    readyState: 0, send: vi.fn(), close: vi.fn(() => { socket.readyState = 3; socket.onclose?.(); }),
    terminate: vi.fn(() => { socket.readyState = 3; socket.onclose?.(); }),
    on: (name, listener) => { listeners.set(name, listener); },
  };
  const factory = vi.fn(() => socket as unknown as WebSocket);
  const machine = new MachineLink({ baseUrl: 'http://127.0.0.1', factory, random: () => 1 });
  const handlers = { registration: () => ({ token: 'bdt_fixture' }), onOpen: vi.fn(), onClose: vi.fn(),
    onMessage: vi.fn(), onUpdateRequired: vi.fn() };
  const refused = machine.attach('a'.repeat(64), handlers);
  refused.start();
  const healthy = sibling ? machine.attach('b'.repeat(64), handlers) : undefined;
  healthy?.start();
  socket.readyState = 1; socket.onopen?.();
  const receive = (event: Record<string, unknown>) => socket.onmessage?.({ data: JSON.stringify(event) });
  if (healthy) receive({ type: 'registered', agentId: healthy.agentId });
  receive({ type: 'register-refused', agentId: refused.agentId, code: 'daemon_token_required' });
  const registrations = socket.send.mock.calls.length;
  try {
    for (let elapsed = 0; elapsed < 60 * 60_000; elapsed += 30_000) {
      await vi.advanceTimersByTimeAsync(30_000);
      if (healthy) listeners.get('ping')?.();
    }
    expect(factory).toHaveBeenCalledTimes(1);
    expect(socket.send).toHaveBeenCalledTimes(registrations);
    expect(socket.close).toHaveBeenCalledTimes(sibling ? 0 : 1);
    expect(machine.link.isOpen()).toBe(sibling);
  } finally { machine.stop(); }
});
