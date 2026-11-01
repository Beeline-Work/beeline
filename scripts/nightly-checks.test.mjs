import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { classify, easternSlot, runNightly } from './nightly-checks.mjs';

const job = (name, conclusion, attempt) => ({ name, conclusion, id: attempt, html_url: `https://example/jobs/${attempt}`, started_at: `2026-01-01T08:0${attempt}:00Z`, completed_at: `2026-01-01T08:0${attempt + 1}:00Z` });
test('nightly schedule selects 03 Eastern in winter and summer and dispatches all on main', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/nightly-checks.yml', import.meta.url), 'utf8'));
  assert.equal(workflow.on.schedule[0].cron, '0 7,8 * * *');
  assert.equal(workflow.permissions.actions, 'write');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  for (const [yes, no] of [['2026-01-01T08:00Z', '2026-01-01T07:00Z'], ['2026-07-01T07:00Z', '2026-07-01T08:00Z']]) {
    assert.equal(easternSlot(new Date(yes)), true);
    assert.equal(easternSlot(new Date(no)), false);
  }
});
test('same SHA failures become flaky only when the retry succeeds, with both links', () => {
  const result = classify([
    { sha: 'abc', jobs: [job('flaky', 'failure', 1), job('broken', 'failure', 1)] },
    { sha: 'abc', jobs: [job('flaky', 'success', 2), job('broken', 'failure', 2)] },
  ]);
  assert.deepEqual(result.flakyJobs.map(j => j.name), ['flaky']);
  assert.deepEqual(result.failures.map(j => j.name), ['broken']);
  assert.deepEqual(result.flakyJobs[0].attempts.map(a => a.html_url), ['https://example/jobs/1', 'https://example/jobs/2']);
  assert.equal(result.runnerMinutes, 4);
  assert.throws(() => classify([{ sha: 'a', jobs: [] }, { sha: 'b', jobs: [] }]), /SHA/);
});
test('controller dispatch → failure → rerun → artifact exercises the exact nightly path', async () => {
  const calls = [], artifacts = [];
  let dispatched = false, attempt = 1;
  const api = async (method, endpoint, body) => {
    calls.push([method, endpoint, body]);
    if (endpoint.includes('unified-release')) return { workflow_runs: [] };
    if (endpoint === 'commits/main') return { sha: 'abc' };
    if (endpoint.endsWith('dispatches')) { assert.deepEqual(body, { ref: 'main', inputs: { suite: 'all' } }); dispatched = true; return; }
    if (endpoint.includes('checks.yml/runs')) return { workflow_runs: dispatched ? [{ id: 7, html_url: 'https://example/runs/7' }] : [] };
    if (endpoint.endsWith('rerun-failed-jobs')) { attempt++; return; }
    if (endpoint.endsWith('/logs')) return 'not ok 1 - failing test';
    if (endpoint.includes('/jobs?')) return { total_count: 1, jobs: [job('suite', attempt === 1 ? 'failure' : 'success', attempt)] };
    return { run_attempt: attempt, status: 'completed', conclusion: attempt === 1 ? 'failure' : 'success', head_sha: 'abc' };
  };
  const result = await runNightly({ api, pause: () => assert.fail('unexpected wait'), manual: true, save: a => artifacts.push(a) });
  assert.equal(result.failures.length, 0);
  assert.equal(result.flakyJobs.length, 1);
  assert.deepEqual(result.flakyJobs[0].attempts[0].failingTests, ['not ok 1 - failing test']);
  assert.equal(calls.filter(c => c[1].endsWith('rerun-failed-jobs')).length, 1);
  assert.equal(artifacts.at(-1).attempts.length, 2);
  assert.match(result.attempts[1].url, /attempts\/2$/);
});
test('active release publishes an explicit skip without dispatching checks', async () => {
  const calls = [];
  const result = await runNightly({ manual: true, pause: () => {}, save: () => {}, api: async (...args) => {
    calls.push(args);
    return { workflow_runs: [{ status: 'in_progress', html_url: 'release' }] };
  } });
  assert.equal(result.skipped, true);
  assert.equal(calls.length, 1);
});
