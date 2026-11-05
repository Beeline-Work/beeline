import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { AgentCommand } from '@beeline/api-contract/daemon';
import type { DaemonApiClient } from './daemon-api-client.js';
import { AcpRuntimeExitedError } from './acp.js';
import { AgentProcesses } from './agent-process.js';
import { CommandExecutionContext, runServerCommandIntake } from './server-command-intake.js';

function command(id: string, body = id, action: AgentCommand['action'] = 'input'): AgentCommand {
  return {
    id,
    roomId: 'room',
    agentId: 'agent',
    sourceMessageId: id,
    turnRequestId: id,
    action,
    reason: 'human_tag',
    rootCommandId: id,
    rootSourceMessageId: id,
    agentDepth: 0,
    source: { id, authorId: 'human', body, createdAt: 1, attachments: [] },
  };
}

it.each([false, true])(
  're-reads a crashed turn from the server only when new work arrives (arrival during exit: %s)',
  async (arrivesDuringExit) => {
    const root = await mkdtemp(join(tmpdir(), 'beeline-process-intake-'));
    const controller = new AbortController();
    const processes = new AgentProcesses();
    let notify!: (commands?: readonly AgentCommand[]) => void;
    let recover: (() => void) | undefined;
    let serverQueue = [command('original', 'old local body')];
    let crash = true;
    let alive = false;
    let errors = 0;
    const bodies: string[] = [];
    const lifecycle = {
      start: vi.fn(async () => {
        alive = true;
        return 'physical';
      }),
      stop: vi.fn(async () => {
        alive = false;
      }),
      isCurrent: async () => alive,
      isRunning: () => alive,
    };
    const execute = vi.fn(async (name: string, input: { commandId?: string }) => {
      if (name === 'getAgentCommands') return { commandProtocol: 1, commands: [...serverQueue] };
      if (name === 'claimAgentCommand') {
        serverQueue = serverQueue.filter((item) => item.id !== input.commandId);
        return {};
      }
      return {};
    });
    const api = { execute } as unknown as DaemonApiClient;
    const running = runServerCommandIntake({
      api,
      roomId: 'room',
      agentId: 'agent',
      context: new CommandExecutionContext(root),
      signal: controller.signal,
      onWake: (wake) => {
        if (wake) notify = wake;
      },
      onRecovery: (listener) => {
        recover = listener;
      },
      stop: () => undefined,
      onError: () => {
        errors++;
      },
      run: (item) =>
        processes.run('agent', lifecycle, async () => {
          bodies.push(item.source.body);
          if (crash) {
            crash = false;
            alive = false;
            // The receipt requeues the durable command and pushes its snapshot.
            serverQueue = [command('original', 'fresh server body')];
            notify([command('original', 'stale pushed body')]);
            if (arrivesDuringExit) {
              serverQueue.push(command('new-work'));
              notify([command('new-work')]);
            }
            throw new AcpRuntimeExitedError('fixture died mid-turn');
          }
        }),
    });
    try {
      await vi.waitFor(() => expect(errors).toBe(1));
      const readsAfterDeath = execute.mock.calls.filter(
        ([name]) => name === 'getAgentCommands',
      ).length;
      if (!arrivesDuringExit) {
        recover?.();
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(lifecycle.start).toHaveBeenCalledOnce();
        expect(execute.mock.calls.filter(([name]) => name === 'getAgentCommands')).toHaveLength(
          readsAfterDeath,
        );
        serverQueue.push(command('new-work'));
        notify([command('new-work')]);
      }
      await vi.waitFor(() =>
        expect(bodies).toEqual(['old local body', 'fresh server body', 'new-work']),
      );
      expect(lifecycle.start).toHaveBeenCalledTimes(2);
      expect(
        execute.mock.calls.filter(([name]) => name === 'getAgentCommands').length,
      ).toBeGreaterThan(1);
    } finally {
      controller.abort();
      await running;
      await processes.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('acknowledges explicit restart after processes stop without restarting the hosted runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-process-restart-'));
  const controller = new AbortController();
  let stopped = false;
  const execute = vi.fn(async (name: string) => {
    if (name === 'getAgentCommands')
      return { commandProtocol: 1, commands: [command('restart', '', 'restart')] };
    if (name === 'acknowledgeAgentCommand') {
      expect(stopped).toBe(true);
      controller.abort();
    }
    return {};
  });
  try {
    await runServerCommandIntake({
      api: { execute } as unknown as DaemonApiClient,
      roomId: 'room',
      agentId: 'agent',
      context: new CommandExecutionContext(root),
      signal: controller.signal,
      run: async () => {
        throw new Error('restart is not a model turn');
      },
      stop: () => undefined,
      restart: async () => {
        stopped = true;
      },
    });
    expect(execute).toHaveBeenCalledWith(
      'acknowledgeAgentCommand',
      expect.objectContaining({ commandId: 'restart' }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('does not reuse an already queued sibling to restart a repeatedly dying process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-no-process-retry-'));
  const controller = new AbortController();
  const processes = new AgentProcesses();
  let notify!: (commands?: readonly AgentCommand[]) => void;
  let serverQueue = [command('original')];
  let failures = 0;
  let alive = false;
  const completed: string[] = [];
  const lifecycle = {
    start: vi.fn(async () => {
      alive = true;
      return 'physical';
    }),
    stop: async () => {
      alive = false;
    },
    isCurrent: async () => alive,
    isRunning: () => alive,
  };
  const execute = vi.fn(async (name: string, input: { commandId?: string }) => {
    if (name === 'getAgentCommands') return { commandProtocol: 1, commands: [...serverQueue] };
    if (name === 'claimAgentCommand')
      serverQueue = serverQueue.filter((item) => item.id !== input.commandId);
    return {};
  });
  const running = runServerCommandIntake({
    api: { execute } as unknown as DaemonApiClient,
    roomId: 'room',
    agentId: 'agent',
    context: new CommandExecutionContext(root),
    signal: controller.signal,
    onWake: (wake) => {
      if (wake) notify = wake;
    },
    stop: () => undefined,
    onError: () => undefined,
    run: (item) =>
      processes.run('agent', lifecycle, async () => {
        if (item.id === 'original' && failures < 2) {
          failures++;
          alive = false;
          serverQueue.unshift(command('original'));
          notify([command('original')]);
          throw new AcpRuntimeExitedError('died again');
        }
        completed.push(item.id);
      }),
  });
  try {
    await vi.waitFor(() => expect(failures).toBe(1));
    serverQueue.push(command('second'));
    notify([command('second')]);
    await vi.waitFor(() => expect(failures).toBe(2));
    await new Promise<void>((resolve) => setImmediate(resolve));
    notify([...serverQueue]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(lifecycle.start).toHaveBeenCalledTimes(2);
    expect(completed).toEqual([]);
    serverQueue.push(command('third'));
    notify([command('third')]);
    await vi.waitFor(() => expect(completed).toEqual(['original', 'second', 'third']));
    expect(lifecycle.start).toHaveBeenCalledTimes(3);
  } finally {
    controller.abort();
    await running;
    await processes.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
