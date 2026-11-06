import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentProcesses,
  resolveSessionIdleMs,
  type AgentProcessLifecycle,
} from './agent-process.js';

const owners: AgentProcesses[] = [];
function owner(idleMs = 60_000) {
  const value = new AgentProcesses({ idleMs });
  owners.push(value);
  return value;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(async () => {
  await Promise.all(owners.splice(0).map((value) => value.dispose()));
  vi.useRealTimers();
});

describe('agent process ownership', () => {
  it('starts every process once in a large burst, with no sweep or capacity ceiling', async () => {
    vi.useFakeTimers();
    const processes = owner();
    expect(vi.getTimerCount()).toBe(0);
    const gate = deferred();
    const lifecycles = Array.from({ length: 64 }, (_, index) => ({
      start: vi.fn(async () => `process-${index}`),
      stop: vi.fn(async () => undefined),
    }));
    const first = lifecycles.map((lifecycle, index) =>
      processes.run(`${index}`, lifecycle, () => gate.promise),
    );
    const second = lifecycles.map((lifecycle, index) =>
      processes.run(`${index}`, lifecycle, async () => undefined),
    );
    await vi.waitFor(() => expect(processes.snapshot().busy).toBe(64));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(lifecycles.every((lifecycle) => lifecycle.start.mock.calls.length === 1)).toBe(true);
    gate.resolve();
    await Promise.all([...first, ...second]);
    expect(processes.snapshot()).toMatchObject({ running: 64, busy: 0, warm: 64 });
    expect(vi.getTimerCount()).toBe(64);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(processes.snapshot().running).toBe(0);
    expect(lifecycles.every((lifecycle) => lifecycle.stop.mock.calls.length === 1)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts one countdown after the last turn and resets it on new work', async () => {
    vi.useFakeTimers();
    const processes = owner();
    const lifecycle = { start: vi.fn(async () => 'physical'), stop: vi.fn(async () => undefined) };
    await processes.run('agent', lifecycle, async () => undefined);
    await vi.advanceTimersByTimeAsync(59_999);
    const gate = deferred();
    const turn = processes.run('agent', lifecycle, () => gate.promise);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(lifecycle.stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    gate.resolve();
    await turn;
    await vi.advanceTimersByTimeAsync(59_999);
    expect(lifecycle.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(lifecycle.stop).toHaveBeenCalledOnce();
    expect(lifecycle.start).toHaveBeenCalledOnce();
  });

  it('retains unfinished background tools and arms the countdown from their completion event', async () => {
    vi.useFakeTimers();
    const processes = owner();
    let background = true;
    let changed: (() => void) | undefined;
    const lifecycle: AgentProcessLifecycle = {
      start: async () => 'physical',
      stop: vi.fn(async () => undefined),
      hasBackgroundWork: () => background,
      onWorkChanged: (listener) => {
        changed = listener;
        return () => {
          changed = undefined;
        };
      },
    };
    await processes.run('agent', lifecycle, async () => undefined);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(lifecycle.stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    background = false;
    changed?.();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lifecycle.stop).toHaveBeenCalledOnce();
  });

  it('waits for teardown before starting new work for the same agent', async () => {
    const processes = owner();
    const gate = deferred();
    const start = vi.fn(async () => 'physical');
    const lifecycle = { start, stop: vi.fn(() => gate.promise) };
    await processes.run('agent', lifecycle, async () => undefined);
    const stopping = processes.stop('agent');
    const turn = processes.run('agent', lifecycle, async () => undefined);
    await Promise.resolve();
    expect(start).toHaveBeenCalledOnce();
    gate.resolve();
    await stopping;
    await turn;
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('preserves storage leases across running processes, teardown and queued work', async () => {
    const processes = owner();
    const gate = deferred();
    let started = false;
    const maintenance = AgentProcesses.withIdleHostRoom('agent', () => gate.promise);
    const turn = processes.run(
      'agent',
      {
        start: async () => {
          started = true;
          return 'physical';
        },
        stop: async () => undefined,
      },
      async () => undefined,
    );
    await Promise.resolve();
    expect(started).toBe(false);
    gate.resolve();
    expect(await maintenance).toBe(true);
    await turn;
    const clean = vi.fn(async () => undefined);
    expect(await processes.withIdleStorage('agent', clean)).toBe(false);
    await processes.stop('agent');
    expect(await processes.withIdleStorage('agent', clean)).toBe(true);
    expect(clean).toHaveBeenCalledOnce();
  });

  it('retires stale retained processes and keeps bounded generation diagnostics', async () => {
    const processes = owner();
    let generation = 0;
    const lifecycle = {
      start: async () => `${++generation}`,
      stop: vi.fn(async () => undefined),
      isCurrent: async () => false,
    };
    for (let index = 0; index < 6; index++)
      await processes.run('agent', lifecycle, async () => undefined);
    expect(processes.generations('agent')).toEqual(['3', '4', '5', '6']);
    expect(lifecycle.stop).toHaveBeenCalledTimes(5);
    processes.forget('agent');
    expect(processes.generations('agent')).toEqual([]);
  });

  it('explicit stop retires background work and leaves intake able to start on later work', async () => {
    const processes = owner();
    let background = true;
    const lifecycle = {
      start: vi.fn(async () => 'physical'),
      hasBackgroundWork: () => background,
      stop: vi.fn(async (force?: boolean) => {
        if (force) background = false;
      }),
    };
    await processes.run('agent', lifecycle, async () => undefined);
    await processes.stopIdle();
    expect(lifecycle.stop).not.toHaveBeenCalled();
    await processes.stopAll();
    expect(background).toBe(false);
    expect(processes.snapshot().running).toBe(0);
    expect(lifecycle.start).toHaveBeenCalledOnce();
    await processes.run('agent', lifecycle, async () => undefined);
    expect(lifecycle.start).toHaveBeenCalledTimes(2);
  });

  it('reads only the stay-warm setting and rejects invalid idle windows', () => {
    expect(resolveSessionIdleMs({ BEELINE_BODY_SESSION_IDLE_MS: '1234' })).toBe(1234);
    expect(resolveSessionIdleMs({ BEELINE_BODY_SESSION_IDLE_MS: '-1' })).toBe(30 * 60_000);
    expect(() => new AgentProcesses({ idleMs: 0 })).toThrow('idleMs');
  });
});
