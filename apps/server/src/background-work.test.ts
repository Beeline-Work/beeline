import { describe, expect, it, vi } from 'vitest';
import { BackgroundWork, startBackgroundWork, startConnectionWork } from './background-work.js';

describe('R-BACKGROUND-WASTE', () => {
  it('keeps repairs on their deadline during a minute of mixed notifications', async () => {
    let now = 0;
    const log = vi.fn();
    const work = new BackgroundWork(() => now, log);
    const jobs = Object.fromEntries(['push', 'sentry', 'deadlines', 'schedules', 'repair'].map(name => [name, vi.fn(async () => {})]));
    for (const [name, job] of Object.entries(jobs)) work.add(name, 60_000, job);
    await work.run(true);
    for (now = 1000; now < 60_000; now += 1000) {
      const name = ['push', 'sentry', 'deadlines'][now / 1000 % 3]!;
      work.wake(name);
      expect(await work.run(false)).toBeGreaterThan(0);
    }
    expect(jobs.repair).toHaveBeenCalledOnce();
    expect(jobs.schedules).toHaveBeenCalledOnce();
    expect(jobs.push).toHaveBeenCalledTimes(20);
    expect(jobs.sentry).toHaveBeenCalledTimes(21);
    expect(jobs.deadlines).toHaveBeenCalledTimes(21);
    await work.run(false);
    expect(jobs.repair).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"repair":2'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"wakes":{"sentry":20,"deadlines":20,"push":19}'));
  });

  it('retains exact due times across unrelated wakes and resets recovery on takeover', async () => {
    let now = 0;
    const work = new BackgroundWork(() => now, () => {});
    const schedule = vi.fn(async () => 25_000);
    const deadline = vi.fn(async () => 10_000);
    const repair = vi.fn(async () => {});
    work.add('schedules', 60_000, schedule);
    work.add('deadlines', 60_000, deadline);
    work.add('repair', 60_000, repair);
    expect(await work.run(true)).toBe(10_000);
    now = 2000;
    work.wake('schedules');
    expect(await work.run(false)).toBe(8000);
    expect(deadline).toHaveBeenCalledOnce();
    now = 10_000;
    expect(await work.run(false)).toBe(10_000);
    expect(deadline).toHaveBeenCalledTimes(2);
    expect(repair).toHaveBeenCalledOnce();
    await work.run(true);
    expect(repair).toHaveBeenLastCalledWith(true);
    expect(repair).toHaveBeenCalledTimes(2);
  });

  it('retains a wake received while a job is running', async () => {
    const work = new BackgroundWork(() => 0, () => {});
    let calls = 0;
    work.add('push', 60_000, async () => { if (++calls === 1) work.wake('push'); });
    expect(await work.run(true)).toBe(0);
    expect(await work.run(false)).toBe(60_000);
    expect(calls).toBe(2);
  });
});

describe('owned timer chains', () => {
  it('keeps connection cadence and cancels the next tick when its owner closes', async () => {
    vi.useFakeTimers();
    try {
      // Other worker activity may own timers while this connection closes.
      const unrelated = setTimeout(() => {}, 60_000);
      const timers = vi.spyOn(globalThis, 'setTimeout');
      const clear = vi.spyOn(globalThis, 'clearTimeout');
      let nextTick: unknown;
      const run = vi.fn();
      const stop = startConnectionWork(() => {
        run();
        if (run.mock.calls.length === 2) {
          nextTick = timers.mock.results.at(-1)!.value;
          stop();
        }
      }, 1000);
      await vi.advanceTimersByTimeAsync(999);
      expect(run).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2001);
      expect(run).toHaveBeenCalledTimes(2);
      expect(nextTick).toBeDefined();
      expect(clear).toHaveBeenCalledWith(nextTick);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(run).toHaveBeenCalledTimes(2);
      clearTimeout(unrelated);
    } finally { vi.restoreAllMocks(); vi.useRealTimers(); }
  });

  it('runs startup work immediately and uses the next queue deadline', async () => {
    vi.useFakeTimers();
    try {
      const work = new BackgroundWork();
      const fast = vi.fn(async () => {}), slow = vi.fn(async () => {});
      work.add('fast', 1000, fast);
      work.add('slow', 5000, slow);
      const stop = startBackgroundWork(work);
      expect(fast).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(5000);
      expect(fast).toHaveBeenCalledTimes(6);
      expect(slow).toHaveBeenCalledTimes(2);
      await stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(fast).toHaveBeenCalledTimes(6);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('drains an active job on close without scheduling another tick', async () => {
    vi.useFakeTimers();
    try {
      let finish!: () => void;
      const work = new BackgroundWork();
      const run = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
      work.add('slow', 1000, run);
      const stop = startBackgroundWork(work);
      await vi.advanceTimersByTimeAsync(5000);
      expect(run).toHaveBeenCalledOnce();
      let stopped = false;
      const closing = stop().then(() => { stopped = true; });
      await Promise.resolve();
      expect(stopped).toBe(false);
      finish();
      await closing;
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
