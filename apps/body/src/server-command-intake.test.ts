import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import type { DaemonApiClient } from './daemon-api-client.js';
import { CommandExecutionContext, runServerCommandIntake, validateServerCommand } from './server-command-intake.js';

const paths: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});
const command = (id = 'c1', action: AgentCommand['action'] = 'input'): AgentCommand => ({
  id, roomId: 'room', agentId: 'agent', sourceMessageId: id, turnRequestId: 'turn',
  rootCommandId: 'root', rootSourceMessageId: 'human', agentDepth: 0, action,
  reason: 'human_tag',
  source: { id, authorId: 'human', body: 'Do it', createdAt: 1, type: 'message', attachments: [] },
});
async function context() {
  const dir = await mkdtemp(join(tmpdir(), 'command-test-'));
  paths.push(dir);
  return new CommandExecutionContext(dir);
}
function socketApi(execute: ReturnType<typeof vi.fn>) {
  let state: ((connected: boolean, capabilities?: { pushIntake: boolean; connectionPresence: boolean }) => void) | undefined;
  let commands: ((commands: readonly AgentCommand[]) => void) | undefined;
  const api = {
    execute,
    liveSubscribe: vi.fn((_roomId, _cursor, _items, onState, _presence, onCommands) => {
      state = onState;
      commands = onCommands;
      return vi.fn();
    }),
  } as unknown as DaemonApiClient;
  return { api, connected: () => state?.(true, { pushIntake: true, connectionPresence: true }),
    disconnected: () => state?.(false),
    unsupported: () => state?.(true, { pushIntake: false, connectionPresence: true }),
    push: (rows: AgentCommand[]) => commands?.(rows) };
}

describe('command intake mechanics', () => {
  it('reports push subscription loss and recovery without reading the server on disconnect', async () => {
    const abort = new AbortController();
    const execute = vi.fn(async (name: string) => name === 'getAgentCommands'
      ? { commandProtocol: 1, commands: [] } : { id: 'ok' });
    const socket = socketApi(execute);
    const states: boolean[] = [];
    const running = runServerCommandIntake({ api: socket.api, roomId: 'room', agentId: 'agent',
      context: await context(), signal: abort.signal, run: vi.fn(), stop: vi.fn(),
      onSubscriptionState: (connected) => states.push(connected) });
    await vi.waitFor(() => expect(socket.api.liveSubscribe).toHaveBeenCalledOnce());
    socket.connected();
    socket.disconnected();
    socket.unsupported();
    expect(states).toEqual([true, false, false]);
    expect(execute.mock.calls.map(([name]) => name)).toEqual(['getAgentCommands']);
    abort.abort();
    await running;
  });
  it('refuses an older server without reading shared traffic', async () => {
    const execute = vi.fn(async () => ({ items: [command().source] }));
    await expect(runServerCommandIntake({ api: { execute } as unknown as DaemonApiClient,
      roomId: 'room', agentId: 'agent', context: await context(), run: vi.fn(), stop: vi.fn(),
    })).rejects.toThrow('protocol');
    expect(execute.mock.calls.map((call) => call[0])).toEqual(['getAgentCommands']);
  });
  it('rejects wrong-target and malformed commands', () => {
    for (const row of [{ ...command(), agentId: 'other' }, { ...command(), roomId: 'other' },
      { ...command(), agentDepth: 4 }, { ...command(), action: 'message' }])
      expect(() => validateServerCommand(row as AgentCommand, 'room', 'agent')).toThrow();
  });
  it('takes no recurring server reads during hours of connected idle time and reconciles once per reconnect', async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const execute = vi.fn(async (name: string) => name === 'getAgentCommands'
      ? { commandProtocol: 1, commands: [] } : { id: 'ok' });
    const socket = socketApi(execute);
    const running = runServerCommandIntake({ api: socket.api, roomId: 'room', agentId: 'agent',
      context: await context(), signal: abort.signal, run: vi.fn(), stop: vi.fn() });
    await vi.waitFor(() => expect(socket.api.liveSubscribe).toHaveBeenCalledOnce());
    socket.connected();
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect(execute.mock.calls.map(([name]) => name)).toEqual(['getAgentCommands']);
    socket.disconnected();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(execute).toHaveBeenCalledTimes(1);
    socket.connected();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(execute).toHaveBeenCalledTimes(2);
    abort.abort();
    await running;
  });
  it('claims a pushed command once and forwards release identity', async () => {
    const abort = new AbortController();
    const execute = vi.fn(async (name: string) => name === 'getAgentCommands'
      ? { commandProtocol: 1, commands: [] } : { id: 'ok' });
    const socket = socketApi(execute);
    const run = vi.fn(async () => abort.abort());
    const presence = { releaseVersion: 'v0.0.68', sourceSha: 'db2618408a205a3f319d26017a953725e7f13b61' };
    const running = runServerCommandIntake({ api: socket.api, roomId: 'room', agentId: 'agent',
      context: await context(), signal: abort.signal, presence, run, stop: vi.fn() });
    await vi.waitFor(() => expect(socket.api.liveSubscribe).toHaveBeenCalledOnce());
    socket.connected();
    socket.push([command(), command()]);
    await running;
    expect(execute.mock.calls.filter(([name]) => name === 'claimAgentCommand')).toHaveLength(1);
    expect(run).toHaveBeenCalledOnce();
    expect(socket.api.liveSubscribe).toHaveBeenCalledWith('room', undefined, undefined,
      expect.any(Function), presence, expect.any(Function));
  });
  it('exits when shutdown aborts during an asynchronous closed check', async () => {
    const abort = new AbortController();
    const execute = vi.fn(async () => ({ commandProtocol: 1, commands: [] }));
    const socket = socketApi(execute);
    const closed = vi.fn(async () => {
      abort.abort();
      return false;
    });
    await runServerCommandIntake({ api: socket.api, roomId: 'room', agentId: 'agent',
      context: await context(), signal: abort.signal, closed, run: vi.fn(), stop: vi.fn() });
    expect(closed).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('processes a pushed stop while an input is running', async () => {
    const abort = new AbortController();
    let release = () => {};
    const run = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const stop = vi.fn(() => { release(); abort.abort(); });
    const execute = vi.fn(async (name: string) => name === 'getAgentCommands'
      ? { commandProtocol: 1, commands: [command('input')] } : { id: 'ok' });
    const socket = socketApi(execute);
    const running = runServerCommandIntake({ api: socket.api, roomId: 'room', agentId: 'agent',
      context: await context(), signal: abort.signal, run, stop });
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    socket.push([command('stop', 'stop')]);
    await running;
    expect(stop).toHaveBeenCalledWith('turn');
    expect(execute).toHaveBeenCalledWith('acknowledgeAgentCommand', expect.anything());
  });
  it('claims a command the server requeued mid-run again once that run ends, in the same process', async () => {
    const abort = new AbortController();
    let release = () => {};
    const run = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }))
      .mockImplementationOnce(async () => abort.abort());
    const execute = vi.fn(async (name: string) => name === 'getAgentCommands'
      ? { commandProtocol: 1, commands: [command()] } : { id: 'ok' });
    const socket = socketApi(execute);
    const running = runServerCommandIntake({ api: socket.api, roomId: 'room', agentId: 'agent',
      context: await context(), signal: abort.signal, run, stop: vi.fn() });
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    // The server failed the stalled turn and requeued the same command.
    socket.push([command()]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(run).toHaveBeenCalledOnce();
    release();
    await running;
    expect(run).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls.filter(([name]) => name === 'claimAgentCommand')).toHaveLength(2);
  });
  it('binds output to the claimed generation and request', async () => {
    const ctx = await context();
    await ctx.enter(command());
    const execute = vi.fn(async () => ({ id: 'ok' }));
    await ctx.bind({ execute } as unknown as DaemonApiClient)
      .execute('postAgentAttachment', { roomId: 'room', attachment: { url: 'url' } });
    expect(execute).toHaveBeenCalledWith('postAgentAttachment',
      expect.objectContaining({ requestId: 'turn', generationId: ctx.generationId }));
  });
  // C112: RoomRuntimeCoordinator.reconcile's repository-revision restart
  // reads a room's `body.isBusy()` to decide whether it is safe to stop and
  // restart. That flag used to flip only once `run()` got around to calling
  // `prompt()`, deep inside the caller - leaving a real window, spanning the
  // claim's own network round trip AND `context.enter()`'s own file I/O,
  // where the caller's turn had already been claimed (or was about to be)
  // but every busy check still read `false`. A same-tick repository-
  // revision reconcile landing in that window stopped the loop (its own
  // shutdown then cancelled the just-claimed command), reporting "stopped
  // by the requester" even though nobody asked - reproduced under induced
  // CPU contention, never without it, since the window is normally a
  // handful of microtasks wide. `onClaiming` exists to close that window: it
  // must fire before the claim attempt even starts, and `onClaimFailed`
  // undoes it if the claim itself is refused, so a caller marks itself busy
  // for exactly as long as (and no less than) it might actually run a turn.
  it('marks a command claiming before the claim round trip and context.enter settle (C112)', async () => {
    const abort = new AbortController();
    const order: string[] = [];
    const ctx = await context();
    const realEnter = ctx.enter.bind(ctx);
    let releaseEnter = () => {};
    const entryGate = new Promise<void>((resolve) => {
      releaseEnter = resolve;
    });
    vi.spyOn(ctx, 'enter').mockImplementation(async (cmd) => {
      order.push('entering');
      await entryGate;
      await realEnter(cmd);
      order.push('entered');
    });
    const run = vi.fn(async () => {
      order.push('run');
      abort.abort();
    });
    let releaseClaim = () => {};
    const claimGate = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    const execute = vi.fn(async (name: string) => {
      if (name === 'getAgentCommands') return { commandProtocol: 1, commands: [command()] };
      if (name === 'claimAgentCommand') {
        order.push('claiming');
        await claimGate;
        return { id: 'ok' };
      }
      return { id: 'ok' };
    });
    const onClaiming = vi.fn(() => order.push('marked-busy'));
    const running = runServerCommandIntake({
      api: { execute } as unknown as DaemonApiClient,
      roomId: 'room',
      agentId: 'agent',
      context: ctx,
      signal: abort.signal,
      run,
      stop: vi.fn(),
      onClaiming,
    });
    await vi.waitFor(() => expect(onClaiming).toHaveBeenCalledOnce());
    // Marked busy before the claim's own network round trip even starts -
    // exactly the earlier, wider window a same-tick reconcile busy-check
    // used to see as idle and stop.
    expect(order).toEqual(['marked-busy', 'claiming']);
    releaseClaim();
    await vi.waitFor(() => expect(order).toContain('entering'));
    expect(order).toEqual(['marked-busy', 'claiming', 'entering']);
    releaseEnter();
    await running;
    expect(order).toEqual(['marked-busy', 'claiming', 'entering', 'entered', 'run']);
  });
  it('undoes the busy mark when the claim itself is refused (C112)', async () => {
    const abort = new AbortController();
    const execute = vi.fn(async (name: string) => {
      if (name === 'getAgentCommands') return { commandProtocol: 1, commands: [command()] };
      if (name === 'claimAgentCommand') throw new Error('command claim conflict');
      return { id: 'ok' };
    });
    const onClaiming = vi.fn();
    const onClaimFailed = vi.fn();
    const onError = vi.fn(() => abort.abort());
    await runServerCommandIntake({
      api: { execute } as unknown as DaemonApiClient,
      roomId: 'room',
      agentId: 'agent',
      context: await context(),
      signal: abort.signal,
      run: vi.fn(),
      stop: vi.fn(),
      onClaiming,
      onClaimFailed,
      onError,
    });
    expect(onClaiming).toHaveBeenCalledOnce();
    expect(onClaimFailed).toHaveBeenCalledOnce();
  });
});
