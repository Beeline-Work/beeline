import assert from 'node:assert/strict';
import test from 'node:test';
import { runNightly } from './nightly-checks.mjs';

test('R-NOISE-19: delayed nightly dispatch uses the Eastern date, including DST twins', async () => {
  for (const [date, selected, twin] of [
    ['2026-11-05T16:24:03.879Z', '7 8 * * *', '7 7 * * *'],
    ['2026-07-05T19:30:00Z', '7 7 * * *', '7 8 * * *'],
    ['2026-11-01T22:00:00Z', '7 8 * * *', '7 7 * * *'],
  ]) {
    const calls = [], saved = [];
    const api = async (method, path, body) => {
      calls.push({ method, path, body });
      if (path.includes('unified-release')) return { workflow_runs: [] };
      if (path === 'commits/main') return { sha: 'head' };
      return null;
    };
    const options = { api, save: r => saved.push(r), now: () => new Date(date), requestId: '123' };
    assert.equal((await runNightly({ ...options, schedule: selected })).dispatched, true);
    const count = calls.length;
    assert.equal(await runNightly({ ...options, schedule: twin }), undefined);
    assert.equal(calls.length, count);
    assert.equal(saved.length, 1);
    assert.equal(calls.filter(c => c.method === 'POST').length, 1);
  }
});
