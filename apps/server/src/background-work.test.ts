import { afterEach, describe, expect, it, vi } from 'vitest';
import { startBackgroundWork } from './background-work.js';
import { OwnerScheduleClock } from './owner-schedule-clock.js';
import { setImmediate, clearImmediate } from 'node:timers';

afterEach(() => vi.useRealTimers());
describe('event-only background work', () => {
  it('startup and elapsed time cannot wake an answered message again', async () => {
    vi.useFakeTimers();
    const answered = vi.fn(async () => {}), job = startBackgroundWork(answered);
    vi.advanceTimersByTime(86400_000);
    expect(answered).not.toHaveBeenCalled();
    job.wake();
    await job.stop();
    vi.advanceTimersByTime(7 * 86400_000);
    expect(answered).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves a source event committed in flight and drains it on shutdown', async () => {
    let finish!: () => void;
    const waiting = new Promise<void>(resolve => { finish = resolve; });
    const run = vi.fn(async () => { if (run.mock.calls.length === 1) await waiting; });
    const job = startBackgroundWork(run);
    job.wake(); job.wake();
    const stopped = job.stop();
    finish(); await stopped;
    expect(run).toHaveBeenCalledTimes(2);
    job.wake(); expect(run).toHaveBeenCalledTimes(2);
  });
  it('preserves a source event arriving as the previous drain settles', async () => {
    const run = vi.fn<() => Promise<void>>();
    const job = startBackgroundWork(run);
    run.mockImplementationOnce(() => {
      const done = Promise.resolve();
      void done.then(() => queueMicrotask(() => job.wake()));
      return done;
    }).mockResolvedValue(undefined);
    job.wake();
    for (let index = 0; index < 10; index++) await Promise.resolve();
    await job.stop();
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('a stalled delivery cannot block an independent owner schedule', async () => {
    let finish!: () => void;
    const delivery = startBackgroundWork(() => new Promise<void>(resolve => { finish = resolve; }));
    const runSchedule = vi.fn(async () => {}), schedule = startBackgroundWork(runSchedule);
    delivery.wake(); schedule.wake();
    await schedule.stop();
    expect(runSchedule).toHaveBeenCalledOnce();
    finish(); await delivery.stop();
  });
  it('a failure does not admit another attempt', async () => {
    vi.useFakeTimers();
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = vi.fn(async () => { throw new Error('unavailable'); }), job = startBackgroundWork(run);
    try {
      job.wake(); await job.stop();
      vi.advanceTimersByTime(86400_000);
      expect(run).toHaveBeenCalledOnce(); expect(report).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { report.mockRestore(); }
  });
});
describe('owner-created schedule clock', () => {
  it('shutdown clears its own handle and preserves another owner timer', () => {
    const nativeSetTimeout = globalThis.setTimeout, nativeClearTimeout = globalThis.clearTimeout;
    vi.useFakeTimers();
    const fakeSetTimeout = globalThis.setTimeout, fakeClearTimeout = globalThis.clearTimeout;
    const set = vi.fn(fakeSetTimeout), clear = vi.fn(fakeClearTimeout);
    // Global spies retain the fake timer descriptor and Vitest restores them
    // again after this file. Install local recording wrappers instead.
    globalThis.setTimeout = set;
    globalThis.clearTimeout = clear;
    const outside = vi.fn(), fire = vi.fn(), clock = new OwnerScheduleClock(fire);
    const unrelated = setTimeout(outside, 60_000);
    try {
      clock.arm(10_000);
      const owned = set.mock.results.at(-1)!.value;
      clock.stop();
      expect(clear).toHaveBeenCalledWith(owned);
      expect(clear).not.toHaveBeenCalledWith(unrelated);
      vi.advanceTimersByTime(60_000);
      expect(outside).toHaveBeenCalledOnce();
      expect(fire).not.toHaveBeenCalled();
    } finally {
      clock.stop(); clearTimeout(unrelated);
      globalThis.setTimeout = fakeSetTimeout;
      globalThis.clearTimeout = fakeClearTimeout;
      vi.useRealTimers();
    }
    // Vitest restores registered spies again when the file ends. That must
    // not reinstall the fake clock into the worker running the next file.
    try {
      vi.restoreAllMocks();
      expect(globalThis.setTimeout).toBe(nativeSetTimeout);
      expect(globalThis.clearTimeout).toBe(nativeClearTimeout);
    } finally {
      globalThis.setTimeout = nativeSetTimeout;
      globalThis.clearTimeout = nativeClearTimeout;
    }
  });

  it('fires only at the supplied time, once, and parks without another schedule', () => {
    vi.useFakeTimers();
    const fire = vi.fn(), clock = new OwnerScheduleClock(fire);
    clock.arm(60_000);
    vi.advanceTimersByTime(59_999); expect(fire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(fire).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(86400_000); expect(fire).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves an owner time beyond the native timer range without firing early', () => {
    vi.useFakeTimers();
    const fire = vi.fn(), clock = new OwnerScheduleClock(fire);
    const delay = 2_147_483_647 + 60_000;
    clock.arm(delay);
    vi.advanceTimersByTime(2_147_483_647);
    expect(fire).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    // Model an outstanding socket cleanup from an earlier file in this worker.
    // Advancing this synchronous clock must not admit another owner's I/O.
    const io = setImmediate(() => setTimeout(() => {}, 120_000));
    try {
      vi.advanceTimersByTime(60_000);
      expect(fire).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { clearImmediate(io); }
  });
  it('a schedule edit replaces the time and shutdown cancels it', () => {
    vi.useFakeTimers();
    const fire = vi.fn(), clock = new OwnerScheduleClock(fire);
    clock.arm(10_000); clock.arm(20_000);
    vi.advanceTimersByTime(10_000); expect(fire).not.toHaveBeenCalled();
    clock.stop(); vi.advanceTimersByTime(86400_000);
    expect(fire).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});
