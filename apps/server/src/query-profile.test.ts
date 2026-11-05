import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { QueryProfiler, QueryWindow } from './query-profile.js';
import { captureSlowQuery } from './sentry.js';
vi.mock('./sentry.js', () => ({ captureSlowQuery: vi.fn() }));

describe('query profiler', () => {
  it('alerts above one second even after the bounded profile map overflows', () => {
    vi.mocked(captureSlowQuery).mockClear();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const profiler = new QueryProfiler();
      for (let index = 0; index < 128; index++) profiler.record(`SELECT ${index}`, 1);
      profiler.record('SELECT $1 FROM messages', 1000);
      expect(captureSlowQuery).not.toHaveBeenCalled();
      profiler.record('SELECT $1 FROM messages', 1001);
      profiler.record('SELECT $1 FROM messages', 1200, { code: '40P01' });
      expect(captureSlowQuery).toHaveBeenNthCalledWith(1, expect.stringMatching(/^[a-f0-9]{16}$/), 1001,
        'SELECT $1 FROM messages', undefined);
      expect(captureSlowQuery).toHaveBeenNthCalledWith(2, expect.any(String), 1200,
        'SELECT $1 FROM messages', '40P01');
      expect(profiler.snapshot().overflow).toBe(3);
    } finally { warn.mockRestore(); }
  });

  it('logs a bounded normalized SQL preview only for slow queries without retaining it in profiles', () => {
    const profiler = new QueryProfiler();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = `\n SELECT $1::text,\n $2::text FROM messages\n WHERE ${'id=$3 OR '.repeat(80)}id=$3 `;
    const normalizedSql = sql.replace(/\s+/g, ' ').trim();
    const fingerprint = createHash('sha256').update(normalizedSql).digest('hex').slice(0, 16);
    try {
      profiler.record(sql, 499);
      expect(warn).not.toHaveBeenCalled();
      profiler.record(sql, 500, { code: '57014' });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith('[database] slow query', {
        fingerprint, durationMs: 500, code: '57014', sqlPreview: normalizedSql.slice(0, 300),
      });
      expect(warn.mock.calls[0]![1].sqlPreview).toHaveLength(300);
      expect(profiler.snapshot().top).toEqual([{
        fingerprint, calls: 2, totalMs: 999, maxMs: 500, errors: 1, timeouts: 1, deadlocks: 0,
      }]);
      expect(JSON.stringify(profiler.snapshot())).not.toContain('SELECT');
    } finally {
      warn.mockRestore();
    }
  });

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
