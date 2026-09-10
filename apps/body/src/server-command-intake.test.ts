import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import type { DaemonApiClient } from './daemon-api-client.js';
import {
  CommandExecutionContext,
  runServerCommandIntake,
  validateServerCommand,
} from './server-command-intake.js';
const paths: string[] = [];
afterEach(async () => {
  for (const p of paths.splice(0)) await rm(p, { recursive: true, force: true });
});
const command = (id = 'c1', action: AgentCommand['action'] = 'input'): AgentCommand => ({
  id,
  roomId: 'room',
  agentId: 'agent',
  sourceMessageId: id,
  turnRequestId: 'turn',
  rootCommandId: 'root',
  rootSourceMessageId: 'human',
  agentDepth: 0,
  action,
  reason: 'human_tag',
  source: {
    id,
    authorId: 'human',
    body: 'Do it',
    createdAt: 1,
    type: 'message',
    mentionIds: [],
    attachments: [],
  },
});
async function context() {
  const dir = await mkdtemp(join(tmpdir(), 'command-test-'));
  paths.push(dir);
  return new CommandExecutionContext(dir);
}
describe('command intake mechanics', () => {
  afterEach(() => vi.useRealTimers());
  it('refuses an older server without ever reading shared traffic', async () => {
    const execute = vi.fn(async () => ({ items: [command().source] }));
    await expect(
      runServerCommandIntake({
        api: { execute } as unknown as DaemonApiClient,
        roomId: 'room',
        agentId: 'agent',
        context: await context(),
        run: vi.fn(),
        stop: vi.fn(),
      }),
    ).rejects.toThrow('protocol');
    expect(execute.mock.calls.map((c) => c[0])).toEqual(['getAgentCommands']);
  });
  it('rejects wrong-target and malformed commands', () => {
    for (const c of [
      { ...command(), agentId: 'other' },
      { ...command(), roomId: 'other' },
      { ...command(), agentDepth: 4 },
      { ...command(), action: 'message' },
    ])
      expect(() => validateServerCommand(c as AgentCommand, 'room', 'agent')).toThrow();
  });
  it('does not start work after losing a claim', async () => {
    const controller = new AbortController(),
      run = vi.fn();
    const execute = vi.fn(async (name: string) => {
      if (name === 'getAgentCommands') return { commandProtocol: 1, commands: [command()] };
      controller.abort();
      throw new Error('claim conflict');
    });
    await runServerCommandIntake({
      api: { execute } as unknown as DaemonApiClient,
      roomId: 'room',
      agentId: 'agent',
      context: await context(),
      signal: controller.signal,
      run,
      stop: vi.fn(),
    });
    expect(run).not.toHaveBeenCalled();
  });
  it('claims one live-pushed command and forwards release identity without availability', async () => {
    const controller = new AbortController();
    let onState:
        | ((
            connected: boolean,
            capabilities?: { pushIntake: boolean; connectionPresence: boolean },
          ) => void)
        | undefined,
      onCommands: ((commands: readonly AgentCommand[]) => void) | undefined;
    const execute = vi.fn(async (name: string) => {
      if (name === 'getAgentCommands') return { commandProtocol: 1, commands: [] };
      return { id: 'ok' };
    });
    const api = {
      execute,
      liveSubscribe: vi.fn(
        (
          _roomId: string,
          _cursor: string | undefined,
          _onItems: unknown,
          state: typeof onState,
          _presence: unknown,
          commands: typeof onCommands,
        ) => {
          onState = state;
          onCommands = commands;
          return vi.fn();
        },
      ),
    } as unknown as DaemonApiClient;
    const run = vi.fn(async () => controller.abort());
    const presence = {
      releaseVersion: 'v0.0.68',
      sourceSha: 'db2618408a205a3f319d26017a953725e7f13b61',
    };
    const running = runServerCommandIntake({
      api,
      roomId: 'room',
      agentId: 'agent',
      context: await context(),
      signal: controller.signal,
      presence,
      run,
      stop: vi.fn(),
    });
    await vi.waitFor(() => expect(onCommands).toBeTypeOf('function'));
    onState?.(true, { pushIntake: true, connectionPresence: true });
    onCommands?.([command(), command()]);
    await running;
    expect(execute.mock.calls.filter(([name]) => name === 'getAgentCommands')).toHaveLength(1);
    expect(execute.mock.calls.filter(([name]) => name === 'claimAgentCommand')).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(api.liveSubscribe).toHaveBeenCalledWith(
      'room',
      undefined,
      undefined,
      expect.any(Function),
      presence,
      expect.any(Function),
    );
  });
  it('reconciles an unavailable live push at one second, not sixty seconds', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let reads = 0;
    const execute = vi.fn(async (name: string) => {
      if (name === 'getAgentCommands')
        return { commandProtocol: 1, commands: reads++ ? [command()] : [] };
      return { id: 'ok' };
    });
    const running = runServerCommandIntake({
      api: { execute } as unknown as DaemonApiClient,
      roomId: 'room',
      agentId: 'agent',
      context: await context(),
      signal: controller.signal,
      run: vi.fn(async () => controller.abort()),
      stop: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(execute.mock.calls.filter(([name]) => name === 'getAgentCommands')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await running;
    expect(execute.mock.calls.filter(([name]) => name === 'getAgentCommands')).toHaveLength(2);
    expect(execute.mock.calls.filter(([name]) => name === 'claimAgentCommand')).toHaveLength(1);
  });
  it('uses a sixty-second recovery sweep only after push intake is acknowledged', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let onState:
      | ((
          connected: boolean,
          capabilities?: { pushIntake: boolean; connectionPresence: boolean },
        ) => void)
      | undefined;
    const execute = vi.fn(async (name: string) =>
      name === 'getAgentCommands' ? { commandProtocol: 1, commands: [] } : { id: 'ok' },
    );
    const api = {
      execute,
      liveSubscribe: vi.fn(
        (
          _roomId: string,
          _cursor: string | undefined,
          _onItems: unknown,
          state: typeof onState,
        ) => {
          onState = state;
          return vi.fn();
        },
      ),
    } as unknown as DaemonApiClient;
    const running = runServerCommandIntake({
      api,
      roomId: 'room',
      agentId: 'agent',
      context: await context(),
      signal: controller.signal,
      run: vi.fn(),
      stop: vi.fn(),
    });
    for (let flush = 0; flush < 5 && !onState; flush += 1) await Promise.resolve();
    expect(onState).toBeTypeOf('function');

    await vi.advanceTimersByTimeAsync(999);
    expect(execute.mock.calls.filter(([name]) => name === 'getAgentCommands')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() =>
      expect(execute.mock.calls.filter(([name]) => name === 'getAgentCommands')).toHaveLength(2),
    );

    onState?.(true, { pushIntake: true, connectionPresence: true });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(execute.mock.calls.filter(([name]) => name === 'getAgentCommands')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() =>
      expect(execute.mock.calls.filter(([name]) => name === 'getAgentCommands')).toHaveLength(3),
    );

    onState?.(false);
    await vi.waitFor(() =>
      expect(execute.mock.calls.filter(([name]) => name === 'getAgentCommands')).toHaveLength(4),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() =>
      expect(execute.mock.calls.filter(([name]) => name === 'getAgentCommands')).toHaveLength(5),
    );
    controller.abort();
    await running;
  });
  it('processes a stop while an authorized input is running', async () => {
    const controller = new AbortController();
    let reads = 0,
      release = () => {};
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const stop = vi.fn(() => {
      release();
      controller.abort();
    });
    const execute = vi.fn(async (name: string) =>
      name === 'getAgentCommands'
        ? {
            commandProtocol: 1,
            commands: [command(reads++ ? 'stop' : 'input', reads > 1 ? 'stop' : 'input')],
          }
        : { id: 'ok' },
    );
    await runServerCommandIntake({
      api: { execute } as unknown as DaemonApiClient,
      roomId: 'room',
      agentId: 'agent',
      context: await context(),
      signal: controller.signal,
      run,
      stop,
      pollMs: 1,
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith('turn');
    expect(execute).toHaveBeenCalledWith('acknowledgeAgentCommand', expect.anything());
  });
  it('leaves later inputs unclaimed while busy and deduplicates repeated delivery', async () => {
    const controller = new AbortController();
    let release = () => {};
    const pending = new Map([
      ['first', command('first')],
      ['second', command('second')],
    ]);
    const execute = vi.fn(async (name: string, input: Record<string, unknown>) => {
      if (name === 'getAgentCommands')
        return { commandProtocol: 1, commands: [...pending.values(), ...pending.values()] };
      if (name === 'claimAgentCommand') pending.delete(String(input.commandId));
      return { id: 'ok' };
    });
    const run = vi.fn(async (c: AgentCommand) => {
      if (c.id === 'first')
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      else controller.abort();
    });
    const running = runServerCommandIntake({
      api: { execute } as unknown as DaemonApiClient,
      roomId: 'room',
      agentId: 'agent',
      context: await context(),
      signal: controller.signal,
      pollMs: 1,
      run,
      stop: vi.fn(),
    });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(
      execute.mock.calls
        .filter(([name]) => name === 'claimAgentCommand')
        .map(([, input]) => input.commandId),
    ).toEqual(['first']);
    release();
    await running;
    expect(run.mock.calls.map(([c]) => c.id)).toEqual(['first', 'second']);
  });
  it('allows the server to redeliver a command after a failed execution', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const execute = vi.fn(async (name: string) =>
      name === 'getAgentCommands' ? { commandProtocol: 1, commands: [command()] } : { id: 'ok' },
    );
    const run = vi.fn(async () => {
      if (++attempts === 1) throw new Error('crashed');
      controller.abort();
    });
    await runServerCommandIntake({
      api: { execute } as unknown as DaemonApiClient,
      roomId: 'room',
      agentId: 'agent',
      context: await context(),
      signal: controller.signal,
      pollMs: 1,
      run,
      stop: vi.fn(),
    });
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('binds every output to the claimed generation and request', async () => {
    const ctx = await context();
    await ctx.enter(command());
    const execute = vi.fn(async () => ({ id: 'ok' }));
    await ctx
      .bind({ execute } as unknown as DaemonApiClient)
      .execute('postAgentAttachment', { roomId: 'room', attachment: { url: 'url' } });
    expect(execute).toHaveBeenCalledWith(
      'postAgentAttachment',
      expect.objectContaining({ requestId: 'turn', generationId: ctx.generationId }),
    );
  });
});
