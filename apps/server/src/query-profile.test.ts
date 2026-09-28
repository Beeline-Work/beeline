import { describe, expect, it, vi } from 'vitest';
import { QueryProfiler, QueryWindow } from './query-profile.js';

describe('query profiler', () => {
  it('ranks fingerprints by total DB time without retaining SQL parameters or unbounded keys', () => {
    const profiler = new QueryProfiler();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    profiler.record('SELECT * FROM messages WHERE id=$1', 300);
    profiler.record('SELECT  *  FROM messages WHERE id=$1', 250);
    profiler.record('SELECT * FROM rooms WHERE id=$1', 400, { code: '57014' });
    const snapshot = profiler.snapshot();
    expect(snapshot.top).toHaveLength(2);
    expect(snapshot.top[0]).toMatchObject({ calls: 2, totalMs: 550, maxMs: 300 });
    expect(snapshot.top[1]).toMatchObject({ calls: 1, errors: 1, timeouts: 1 });
    expect(JSON.stringify(snapshot)).not.toContain('messages');
    for (let index = 0; index < 129; index++) profiler.record(`SELECT ${index}`, 1);
    expect(profiler.snapshot()).toMatchObject({ overflow: 3 });
    expect(profiler.snapshot().top.length).toBeLessThanOrEqual(10);
    vi.restoreAllMocks();
  });
});

describe('rolling query window', () => {
  it('keeps only completed events in the last ten minutes and reports p95 and p99', () => {
    const window = new QueryWindow();
    for (let index = 0; index < 40; index++) {
      window.recordQuery(index === 0 ? 6001 : 20, 1_000_000);
      window.recordCheckout(2, 0, 1_000_000);
    }
    expect(window.snapshot(1_000_000)).toMatchObject({
      windowMinutes: 10, queryCount: 40, queryP95Ms: 20, queryP99Ms: 6001,
      waitP95Ms: 2, waiterP95: 0,
    });
    expect(window.snapshot(1_600_001)).toMatchObject({
      queryCount: 0, queryP95Ms: null, checkoutCount: 0,
    });
  });
});
