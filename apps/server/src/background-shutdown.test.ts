import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { BackgroundJobRunner, BackgroundLeader, type LeaderConnection } from './background.js';
import { captureServerError } from './sentry.js';

vi.mock('./sentry.js', () => ({ captureServerError: vi.fn() }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function connection() {
  return {
    query: async <Row>() => ({ rows: [{ locked: true }] as Row[] }),
    release: vi.fn(),
  } satisfies LeaderConnection;
}

describe('background shutdown', () => {
  it('AC-3: drains every job before closing pools without waiting for another cycle', async () => {
    const entered = deferred();
    const resume = deferred();
    const client = connection();
    const runner = new BackgroundJobRunner();
    const completed: string[] = [];
    const errors: string[] = [];
    let poolsClosed = false;
    const cycle = vi.fn(async () => {
      entered.resolve();
      await resume.promise;
      for (const job of ['sentry-wakes', 'free-agents', 'schedule-next-due']) {
        await runner.run(job, async () => {
          if (poolsClosed) {
            errors.push(`${job}: Cannot use a pool after calling end on the pool`);
            throw new Error(errors.at(-1));
          }
          completed.push(job);
        });
      }
      return 25;
    });
    const leader = new BackgroundLeader({ connectDedicated: async () => client }, cycle);
    const running = leader.run();
    await entered.promise;
    const shutdown = (async () => {
      await leader.stop();
      poolsClosed = true;
    })();
    // Let an incorrectly synchronous stop close the pools before resuming the cycle.
    await Promise.resolve();
    await Promise.resolve();
    const closedDuringCycle = poolsClosed;
    const releasedDuringCycle = client.release.mock.calls.length;
    resume.resolve();
    await Promise.all([running, shutdown]);
    expect(errors).toEqual([]);
    expect(closedDuringCycle).toBe(false);
    expect(releasedDuringCycle).toBe(0);
    expect(completed).toEqual(['sentry-wakes', 'free-agents', 'schedule-next-due']);
    expect(poolsClosed).toBe(true);
    expect(cycle).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledWith(true);
    await leader.stop();
    expect(client.release).toHaveBeenCalledOnce();
  }, 1000);

  it('does not start a cycle when stopped during the connection health check', async () => {
    const checking = deferred();
    const resume = deferred();
    const client = connection();
    client.query = async <Row>(sql?: string) => {
      if (sql === 'SELECT 1') {
        checking.resolve();
        await resume.promise;
      }
      return { rows: [{ locked: true }] as Row[] };
    };
    const cycle = vi.fn(async () => {});
    const leader = new BackgroundLeader({ connectDedicated: async () => client }, cycle);
    const running = leader.run();
    await checking.promise;
    const stopped = leader.stop();
    resume.resolve();
    await Promise.all([running, stopped]);
    expect(cycle).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('interrupts a sleeping leader without waiting for its next cycle', async () => {
    const completed = deferred();
    const client = connection();
    const cycle = vi.fn(async () => { completed.resolve(); return 60_000; });
    const leader = new BackgroundLeader({ connectDedicated: async () => client }, cycle);
    const running = leader.run();
    await completed.promise;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await leader.stop();
    await running;
    expect(cycle).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledOnce();
  }, 1000);

  it('keeps genuine database errors captured with their job tags', async () => {
    vi.mocked(captureServerError).mockClear();
    const error = new Error('database query failed');
    const runner = new BackgroundJobRunner();
    for (const name of ['sentry-wakes', 'free-agents', 'schedule-next-due']) {
      expect(await runner.run(name, async () => { throw error; })).toEqual({ ok: false });
      expect(captureServerError).toHaveBeenCalledWith(error, { background_job: name });
    }
    expect(captureServerError).toHaveBeenCalledTimes(3);
  });

  it('wires the drain into server shutdown before any pools close', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const shutdown = source.slice(source.indexOf('const stop = async () =>'));
    expect(shutdown).toContain('await leader.stop();');
    expect(shutdown.indexOf('await leader.stop();')).toBeLessThan(shutdown.indexOf('database.close()'));
  });

  it('Reproduction MA-1: merge recovery repeats after startup on the reconciliation interval', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const repairStart = source.indexOf("work.add('repair', reconciliationMs, async (newLeader) => {");
    expect(repairStart).toBeGreaterThan(-1);
    const recurring = source.slice(repairStart);
    const cycle = recurring.slice(0, recurring.indexOf('const leader = new BackgroundLeader'));
    expect(cycle).toContain('githubJobs.recoverUnfinishedMergeClaims()');
    expect(cycle).toContain('githubJobs.reconcileMergedCorners()');
    expect(source).not.toContain('recoveredCornerMerges');
    expect(source).not.toContain('reconciledMergedCorners');
  });
});
