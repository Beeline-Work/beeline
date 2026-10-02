import type { AgentCommand } from '@beeline/api-contract/daemon';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonApiClient } from './daemon-api-client.js';
import { RoomSupervisor } from './room-supervisor.js';
import { CommandExecutionContext, runServerCommandIntake } from './server-command-intake.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const AGENT = 'a'.repeat(64);

function command(id: string): AgentCommand {
  return {
    id,
    roomId: 'room-1',
    agentId: AGENT,
    action: 'input',
    reason: 'mention',
    agentDepth: 0,
    sourceMessageId: `message-${id}`,
    rootSourceMessageId: `message-${id}`,
    turnRequestId: `turn-${id}`,
    rootCommandId: id,
    source: { id: `message-${id}`, authorId: 'b'.repeat(64), createdAt: 1, type: 'message', body: 'hi', attachments: [] },
  } as unknown as AgentCommand;
}

const networkFailure = () =>
  Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });

function fakeApi(handler: (name: string) => Promise<unknown>) {
  let onState: ((connected: boolean, capabilities?: { pushIntake: boolean }) => void) | undefined;
  const execute = vi.fn(async (name: string) => handler(name));
  const api = {
    execute,
    liveSubscribe: vi.fn(
      (_roomId: string, _cursor: unknown, _items: unknown, state: typeof onState) => {
        onState = state;
        return () => undefined;
      },
    ),
  } as unknown as DaemonApiClient;
  return { api, execute, subscribed: (connected = true) => onState?.(connected, { pushIntake: true }) };
}

describe('RoomSupervisor', () => {
  it('retries a failed Room read three times, then waits for the next open or wake', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let reachable = false;
    const { api, execute } = fakeApi(async (name) => {
      if (name !== 'getAgentCommands') throw new Error(`unexpected ${name}`);
      if (!reachable) throw networkFailure();
      return { commandProtocol: 1, commands: [] };
    });
    const supervisor = new RoomSupervisor();
    const abort = new AbortController();
    const polled = vi.fn();
    const supervised = supervisor.supervise('Room room-1', abort.signal, (progress) =>
      runServerCommandIntake({
        api,
        roomId: 'room-1',
        agentId: AGENT,
        context: new CommandExecutionContext(),
        signal: abort.signal,
        onPoll: () => {
          progress();
          polled();
        },
        run: async () => undefined,
        stop: () => undefined,
      }),
    );
    let settled = false;
    void supervised.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(execute).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(execute).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(execute).toHaveBeenCalledTimes(4);
    // Parked: hours pass without another read, and the loop is still supervised.
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    expect(execute).toHaveBeenCalledTimes(4);
    expect(settled).toBe(false);

    reachable = true;
    supervisor.wake(); // the live socket opened again, or discovery was woken
    await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledTimes(5);
    expect(polled).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    abort.abort();
    await supervised;
  });

  it('re-enters intake only after the running turn settles, so its command is claimed once', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const pending = command('cmd-1');
    let completed = false;
    let reconcileFails = true;
    const { api, execute, subscribed } = fakeApi(async (name) => {
      if (name === 'getAgentCommands') {
        // A claimed but unfinished command is still listed by the server.
        if (execute.mock.calls.filter(([called]) => called === 'getAgentCommands').length > 1 && reconcileFails) {
          reconcileFails = false;
          throw networkFailure();
        }
        return { commandProtocol: 1, commands: completed ? [] : [pending] };
      }
      if (name === 'claimAgentCommand') return {};
      throw new Error(`unexpected ${name}`);
    });
    let finishTurn!: () => void;
    const turnStarted = vi.fn();
    const stop = vi.fn();
    const supervisor = new RoomSupervisor();
    const abort = new AbortController();
    const context = new CommandExecutionContext();
    const supervised = supervisor.supervise('Room room-1', abort.signal, (progress) =>
      runServerCommandIntake({
        api,
        roomId: 'room-1',
        agentId: AGENT,
        context,
        signal: abort.signal,
        onPoll: progress,
        stop,
        run: () => {
          turnStarted();
          return new Promise<void>((resolve) => {
            finishTurn = () => {
              completed = true;
              resolve();
            };
          });
        },
      }),
    );
    // Entering a turn writes its context file, which is real I/O.
    await vi.waitFor(() => expect(turnStarted).toHaveBeenCalledOnce());
    // The socket reconnects mid-turn and the reconciliation read fails.
    subscribed();
    subscribed();
    await vi.advanceTimersByTimeAsync(0);
    expect(execute.mock.calls.filter(([name]) => name === 'getAgentCommands')).toHaveLength(2);
    // Intake has failed, yet the turn keeps running and nothing re-enters.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stop).not.toHaveBeenCalled();
    expect(execute.mock.calls.filter(([name]) => name === 'getAgentCommands')).toHaveLength(2);

    finishTurn();
    await vi.waitFor(
      () =>
        expect(execute.mock.calls.filter(([name]) => name === 'getAgentCommands')).toHaveLength(3),
      { timeout: 5_000, interval: 100 },
    );
    expect(execute.mock.calls.filter(([name]) => name === 'claimAgentCommand')).toHaveLength(1);
    expect(turnStarted).toHaveBeenCalledOnce();
    abort.abort();
    await supervised;
  });
});
