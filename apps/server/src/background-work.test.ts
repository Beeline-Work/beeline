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


describe('semantic deadline jobs',()=>{
  it('runs one acquisition pass and then sleeps forever when no real obligation exists',async()=>{
    let now=0;const run=vi.fn(async()=>{}),work=new BackgroundWork(()=>now,()=>{});
    work.addDeadline('delivery',run);
    expect(await work.run(true)).toBe(Infinity);expect(run).toHaveBeenCalledOnce();
    now=24*60*60_000;expect(await work.run(false)).toBe(Infinity);expect(run).toHaveBeenCalledOnce();
    work.wake('delivery','committed-row');expect(await work.run(false)).toBe(Infinity);expect(run).toHaveBeenCalledTimes(2);
  });
  it('arms only an actual returned due time and parks after a completed obligation',async()=>{
    let now=0;const work=new BackgroundWork(()=>now,()=>{});
    const run=vi.fn<()=>Promise<number|void>>().mockResolvedValueOnce(15_000).mockResolvedValue(undefined);
    work.addDeadline('delivery',run);
    expect(await work.run(true)).toBe(15_000);now=14_999;expect(await work.run(false)).toBe(1);expect(run).toHaveBeenCalledOnce();
    now=15_000;expect(await work.run(false)).toBe(Infinity);expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('owned timer chains', () => {
  it('keeps connection cadence and cancels the next tick when its owner closes', async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn();
      const stop = startConnectionWork(() => { run(); if (run.mock.calls.length === 2) stop(); }, 1000);
      await vi.advanceTimersByTimeAsync(999);
      expect(run).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2001);
      expect(run).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
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

  it('parks an empty instance owner with no timer and resumes once on an actual wake', async () => {
    vi.useFakeTimers();
    let stop!: () => Promise<void>;
    try {
      const work = new BackgroundWork();
      const run = vi.fn(async () => {});
      const release = vi.fn();
      let wake!: () => void;
      work.addDeadline('delivery', run);
      stop = startBackgroundWork(work, tick => {
        wake = () => { work.wake('delivery'); tick(); }; return release;
      });
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(run).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
      wake(); await vi.advanceTimersByTimeAsync(0);
      expect(run).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
      await stop(); expect(release).toHaveBeenCalledOnce();
      wake(); await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(run).toHaveBeenCalledTimes(2);
    } finally { await stop?.(); vi.useRealTimers(); }
  });

  it('coalesces committed wakes during a slow instance drain without overlap', async () => {
    vi.useFakeTimers();
    let finish!: () => void, wake!: () => void;
    const work = new BackgroundWork();
    const run = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }))
      .mockResolvedValue(undefined);
    work.addDeadline('delivery', run);
    const stop = startBackgroundWork(work, tick => {
      wake = () => { work.wake('delivery'); tick(); }; return () => {};
    });
    try {
      wake(); wake();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(run).toHaveBeenCalledOnce();
      finish(); await vi.advanceTimersByTimeAsync(0);
      expect(run).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
    } finally { finish(); await stop(); vi.useRealTimers(); }
  });

  it('does not schedule a failed instance job and accepts a distinct recovery wake', async () => {
    vi.useFakeTimers();
    const work = new BackgroundWork(); let wake!: () => void;
    const run = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue(undefined);
    work.addDeadline('delivery', run);
    const stop = startBackgroundWork(work, tick => {
      wake = () => { work.wake('delivery'); tick(); }; return () => {};
    });
    try {
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
      expect(run).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
      wake(); await vi.advanceTimersByTimeAsync(0);
      expect(run).toHaveBeenCalledTimes(2);
    } finally { await stop(); vi.useRealTimers(); }
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
