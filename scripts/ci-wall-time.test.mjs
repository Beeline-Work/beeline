import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeRuns } from './ci-wall-time.mjs';
const run = (id, conclusion = 'success', status = 'completed') => ({ id, conclusion, status,
  head_sha: 'a'.repeat(40), html_url: `https://example.test/runs/${id}`, created_at: '2026-11-04T19:00:00Z' });
const job = (name, start, end, extra = {}) => ({ name, labels: ['ubuntu-latest'], status: 'completed', conclusion: 'success',
  created_at: '2026-11-04T19:00:00Z', started_at: `2026-11-04T19:${start}:00Z`, completed_at: `2026-11-04T19:${end}:00Z`, ...extra });
test('push-to-green includes queue and a rerun; a short final execution is not a fast PR', () => {
  const report = summarizeRuns([run(1)], { 1: [job('TYPECHECK', '20', '24'), job('TYPECHECK', '25', '26')] }, { limit: 1 });
  assert.equal(report.runs[0].elapsedMinutes, 26);
  assert.equal(report.accepted, false);
  assert.equal(report.jobs[0].queueP99, 25);
  const recovered = summarizeRuns([run(1)], { 1: [job('TYPECHECK', '01', '04', { conclusion: 'failure' }), job('TYPECHECK', '05', '14')] }, { limit: 1 });
  assert.equal(recovered.accepted, true);
});
test('all ten successful runs must meet the target; incomplete, failed and cancelled runs cannot pass', () => {
  const runs = Array.from({ length: 10 }, (_, i) => run(i + 1));
  const jobs = Object.fromEntries(runs.map(r => [r.id, [job('TYPECHECK', '02', '14')]]));
  assert.equal(summarizeRuns(runs, jobs).accepted, true);
  for (const conclusion of ['failure', 'cancelled']) {
    assert.equal(summarizeRuns([run(1, conclusion)], { 1: jobs[1] }, { limit: 1 }).accepted, false);
  }
  const pending = summarizeRuns([run(1, null, 'queued')], {}, { limit: 1, now: '2026-11-04T19:35:00Z' });
  assert.equal(pending.runs[0].elapsedMinutes, 35);
  assert.equal(pending.runs[0].lowerBound, true);
  assert.equal(pending.accepted, false);
  assert.equal(summarizeRuns(runs.slice(0, 9), jobs).accepted, false);
  assert.equal(summarizeRuns([run(1)], { 1: [job('TYPECHECK', '00', '00', { conclusion: 'skipped' })] }, { limit: 1 }).accepted, false);
});
test('job groups distinguish pools and reject negative API queue samples', () => {
  const result = summarizeRuns([run(1)], { 1: [job('TYPECHECK', '02', '04'),
    job('TYPECHECK', '01', '05', { labels: ['self-hosted', 'beeline-ci'], created_at: '2026-11-04T19:02:00Z' })] });
  assert.equal(result.jobs.length, 2);
  assert.equal(result.jobs.find(j => j.pool === 'hosted').runtimeP99, 2);
  assert.equal(result.jobs.find(j => j.pool === 'squire').queueSamples, 0);
  assert.equal(result.invalidQueueSamples, 1);
});
