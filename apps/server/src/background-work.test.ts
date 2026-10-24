import { describe, expect, it, vi } from 'vitest';
import { BackgroundWork } from './background-work.js';

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
