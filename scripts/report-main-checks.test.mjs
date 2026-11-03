import assert from 'node:assert/strict';
import test from 'node:test';
import { reportMainChecks } from './report-main-checks.mjs';

const run = { id: 1, name: 'Checks', event: 'push', head_branch: 'main', status: 'completed', conclusion: 'failure', head_sha: 'head', html_url: 'https://example.invalid/runs/1', run_attempt: 1 };

test('main failures create the existing fix-loop issue without retrying the test', async () => {
  const mutations = [];
  const api = async (method, path, body) => {
    if (method !== 'GET') { mutations.push({ method, path, body }); return {}; }
    if (path === 'actions/runs/1') return run;
    if (path.includes('/jobs?')) return { total_count: 1, jobs: [{ name: 'SERVER SUITE', conclusion: 'failure', html_url: 'https://example.invalid/jobs/1' }] };
    if (path.startsWith('issues?')) return [];
    throw Error(path);
  };
  const result = await reportMainChecks({ api, runId: 1 });
  assert.equal(result.failures.length, 1);
  assert.deepEqual(mutations.map(x => x.path), ['issues']);
  assert.equal(mutations[0].body.title, 'Main Checks: SERVER SUITE failed');
  assert.ok(mutations[0].body.labels.includes('nightly-checks'));
});

test('PRs, foreign branches, unrelated workflows and incomplete runs never publish issues', async () => {
  for (const change of [{ event: 'pull_request' }, { head_branch: 'feature' }, { name: 'Unrelated' }, { status: 'in_progress' }]) {
    const calls = [];
    const result = await reportMainChecks({ runId: 1, api: async (method, path) => { calls.push([method, path]); return { ...run, ...change }; } });
    assert.equal(result.skipped, true);
    assert.deepEqual(calls, [['GET', 'actions/runs/1']]);
  }
});

test('a passing main result closes its own failure and leaves nightly failures alone', async () => {
  const mutations = [];
  const api = async (method, path, body) => {
    if (method !== 'GET') { mutations.push({ method, path, body }); return {}; }
    if (path === 'actions/runs/1') return { ...run, conclusion: 'success' };
    if (path.includes('/jobs?')) return { total_count: 1, jobs: [{ name: 'SERVER SUITE', conclusion: 'success' }] };
    if (path.startsWith('issues?')) return [
      { number: 3, title: 'Main Checks: SERVER SUITE failed' },
      { number: 4, title: 'Nightly Checks: SERVER SUITE failed twice' },
    ];
    throw Error(path);
  };
  await reportMainChecks({ api, runId: 1 });
  assert.deepEqual(mutations.map(x => x.path), ['issues/3/comments', 'issues/3']);
});

test('a manual successful rerun still reports the original main failure as flaky', async () => {
  const notes = [];
  const api = async (method, path, body) => {
    if (method !== 'GET') { notes.push(body); return {}; }
    if (path === 'actions/runs/1') return { ...run, conclusion: 'success', run_attempt: 2 };
    if (path.includes('/jobs?')) return { total_count: 1, jobs: [{ name: 'SERVER SUITE', conclusion: path.includes('/attempts/1/') ? 'failure' : 'success', html_url: 'https://example.invalid/jobs/1' }] };
    if (path.startsWith('issues?')) return [];
    throw Error(path);
  };
  const result = await reportMainChecks({ api, runId: 1 });
  assert.equal(result.flakyJobs.length, 1);
  assert.equal(notes[0].title, 'Main Checks: SERVER SUITE is flaky');
});
