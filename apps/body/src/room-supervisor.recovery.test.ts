import { afterEach, describe, expect, it, vi } from 'vitest';
import { DaemonApiError } from './daemon-api-client.js';
import type { DaemonApiClient } from './daemon-api-client.js';
import { RoomSupervisor } from './room-supervisor.js';
import { CommandExecutionContext, runServerCommandIntake } from './server-command-intake.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const AGENT = 'a'.repeat(64);

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

describe('Room read recovery',()=>{
  it('bounds failed read retries and renews recovery on a real wake', async () => {
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
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(execute).toHaveBeenCalledTimes(4);expect(settled).toBe(false);
    reachable=true;supervisor.wake();await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledTimes(5);
    expect(polled).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    abort.abort();
    await supervised;
  });

  it('recovers a transient Room read without a socket/focus/manual wake',async()=>{
    vi.useFakeTimers();vi.spyOn(console,'error').mockImplementation(()=>{});
    const run=vi.fn().mockRejectedValueOnce(networkFailure()).mockResolvedValue(undefined);
    const supervisor=new RoomSupervisor();const result=supervisor.supervise('Room',undefined,run);
    await vi.advanceTimersByTimeAsync(249);expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);await result;expect(run).toHaveBeenCalledTimes(2);
  });

});
