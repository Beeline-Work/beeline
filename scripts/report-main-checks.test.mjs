import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { reportMainChecks } from './report-main-checks.mjs';

const run = { id: 1, name: 'Checks', event: 'push', head_branch: 'main', status: 'completed', conclusion: 'failure', head_sha: 'head', html_url: 'https://example.invalid/runs/1', run_attempt: 1 };

test('R-NOISE-20: bad GitHub replies report once without replay; a later invocation files normally', () => {
  const dir = mkdtempSync(join(tmpdir(), 'main-checks-'));
  try {
    const calls = join(dir, 'calls');
    // A local gh stand-in exercises the actual CLI, including process failures.
    writeFileSync(join(dir, 'gh'), `#!/usr/bin/env node\nconst fs = require('node:fs');
fs.appendFileSync(process.env.CALLS, JSON.stringify(process.argv.slice(2))+'\\n');
const path = process.argv[5];
if (process.env.BAD_REPLY === 'process' && path.endsWith('/issues')) { console.error('unexpected end of JSON input'); process.exit(1); }
if (process.env.BAD_REPLY === 'json') { console.log('{'); process.exit(0); }
if (path.endsWith('/actions/runs/1')) console.log(JSON.stringify(${JSON.stringify(run)}));
else if (path.includes('/jobs?')) console.log(JSON.stringify({total_count:1,jobs:[{name:'SERVER SUITE',conclusion:'failure'}]}));
else if (path.includes('/issues?')) console.log('[]');
else { fs.readFileSync(0,'utf8'); console.log('{}'); }
`, { mode: 0o755 });
    const invoke = bad => spawnSync(process.execPath, [resolve('scripts/report-main-checks.mjs')], {
      encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CALLS: calls,
        CHECKS_RUN_ID: '1', GITHUB_REPOSITORY: 'fixture/repo', GITHUB_STEP_SUMMARY: '', BAD_REPLY: bad },
    });
    for (const bad of ['json', 'process']) {
      writeFileSync(calls, '');
      const failed = invoke(bad);
      assert.equal(failed.status, 1);
      assert.equal(failed.stderr.trim().split('\n').length, 1, failed.stderr);
      assert.match(failed.stderr, /Main Checks reporting failed:/);
      assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, bad === 'process' ? 4 : 1);
    }
    writeFileSync(calls, '');
    const later = invoke('');
    assert.equal(later.status, 0, later.stderr);
    assert.match(later.stdout, /Main Checks: SERVER SUITE failed/);
    assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 4);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

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

test('cancelled and other non-failure conclusions skip job reads and issue mutations', async () => {
  for (const conclusion of ['cancelled', 'skipped', 'neutral', 'timed_out', 'action_required', null]) {
    const calls = [];
    const result = await reportMainChecks({ runId: 1, api: async (method, path) => {
      calls.push([method, path]);
      assert.equal(path, 'actions/runs/1');
      return { ...run, conclusion };
    } });
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

test('a manual successful rerun classifies the original failure without opening or updating issues', async () => {
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
  assert.deepEqual(notes, []);
});
