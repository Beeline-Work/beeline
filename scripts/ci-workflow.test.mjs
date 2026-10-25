import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

const jobs = parse(readFileSync(new URL('../.github/workflows/checks.yml', import.meta.url), 'utf8')).jobs;

test('isolated runners require activation and only accept main pushes or same-repository PRs', () => {
  const critical = ['changes', 'shared-package-tests', 'server-suite-shard', 'server-claim-latency', 'server-suite'];
  const repository = 'Beeline-Work/beeline';
  const pullRequest = (head = repository, base = repository) => ({
    event_name: 'pull_request', repository,
    event: { pull_request: { head: { repo: { full_name: head } }, base: { repo: { full_name: base } } } },
  });
  for (const name of critical) {
    const expression = jobs[name]['runs-on'];
    assert.ok(expression.startsWith('${{ ') && expression.endsWith(' }}'));
    // This routing expression uses only operators shared by GitHub and JS.
    const evaluate = new Function('github', 'vars', 'fromJSON', `return (${expression.slice(4, -3)});`);
    const route = (github, enabled = 'enabled') => evaluate(github, { BEELINE_CI_SHARDS: enabled }, JSON.parse);
    assert.deepEqual(route(pullRequest()), ['self-hosted', 'Linux', 'X64', 'beeline-ci-shard']);
    assert.equal(route(pullRequest(), ''), 'ubuntu-latest');
    assert.equal(route(pullRequest(), 'disabled'), 'ubuntu-latest');
    assert.equal(route(pullRequest('outsider/fork')), 'ubuntu-latest');
    assert.equal(route(pullRequest(repository, 'another/base')), 'ubuntu-latest');
    assert.deepEqual(route({ event_name: 'push', ref: 'refs/heads/main' }), ['self-hosted', 'Linux', 'X64', 'beeline-ci-shard']);
    assert.equal(route({ event_name: 'push', ref: 'refs/heads/topic' }), 'ubuntu-latest');
    for (const event_name of ['merge_group', 'workflow_dispatch', 'pull_request_target', 'schedule']) {
      assert.equal(route({ event_name }), 'ubuntu-latest');
    }
  }
  for (const [name, job] of Object.entries(jobs)) {
    if (!critical.includes(name)) assert.ok(!JSON.stringify(job['runs-on']).includes('beeline-ci-shard'), name);
  }
});

test('required contexts survive server runner consolidation', () => {
  const names = Object.values(jobs).map((job) => job.name);
  for (const name of ['TYPECHECK', 'SHARED PACKAGE TESTS', 'BODY SUITE', 'SERVER SUITE',
    'SERVER INTEGRATION', 'SERVER CLAIM LATENCY', 'MAC HELPER ACCEPTANCE', 'DEAD CODE',
    'MOBILE SUITE', 'MOBILE-EXPORT REACHABILITY', 'PRODUCTION-CORPUS REPLAY',
    'FRAME-BUDGET', 'STATE-UPGRADE', 'NATIVE FINGERPRINT', 'README PARITY',
    'APP LINK ASSOCIATIONS', 'ACTIONLINT', 'Build auth container', 'Detect changes']) {
    assert.ok(names.includes(name), `missing check context: ${name}`);
  }
});

test('four runners retain all eight bounded integration batches and fail closed', () => {
  const shard = jobs['server-suite-shard'];
  assert.deepEqual(shard.strategy.matrix.shard, [1, 2, 3, 4]);
  const integration = shard.steps.find((step) => step.name === 'Run two bounded integration batches');
  assert.ok(integration);
  assert.match(integration.run, /"\$SHARD\/8"/);
  assert.match(integration.run, /"\$\(\(SHARD \+ 4\)\)\/8"/);
  assert.deepEqual([1, 2, 3, 4].flatMap((n) => [n, n + 4]).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
  for (const gate of ['server-suite', 'server-integration']) {
    assert.ok(jobs[gate].needs.includes('server-suite-shard'));
    assert.match(JSON.stringify(jobs[gate].steps), /needs.server-suite-shard.result/);
    assert.match(JSON.stringify(jobs[gate].steps), /success/);
  }
});

test('every Linux workspace consumer waits for the shared preparation job', () => {
  for (const [name, job] of Object.entries(jobs)) {
    if (name === 'shared-package-tests') continue;
    if (!job.steps?.some((step) => step.uses === './.github/actions/ci-workspace')) continue;
    const needs = Array.isArray(job.needs) ? job.needs : [job.needs];
    assert.ok(needs.includes('shared-package-tests'), `${name} races cache preparation`);
  }
  const action = parse(readFileSync(new URL('../.github/actions/ci-workspace/action.yml', import.meta.url), 'utf8'));
  const builds = action.runs.steps.find((step) => step.id === 'builds');
  assert.match(builds.with.key, /github.sha/);
  assert.equal(builds.with['restore-keys'], undefined, 'compiled code must never fall back to another commit');
  const mobile = action.runs.steps.find((step) => step.id === 'mobile');
  assert.match(mobile.with.key, /patch-livekit-abort.cjs/);
  assert.match(mobile.with.path, /public\/canvaskit.wasm/);
});
