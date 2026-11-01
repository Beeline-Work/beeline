import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

const jobs = parse(readFileSync(new URL('../.github/workflows/checks.yml', import.meta.url), 'utf8')).jobs;

test('preparation, verdicts and the timing-sensitive PostgreSQL budget stay hosted', () => {
  const critical = ['changes', 'shared-package-tests', 'server-claim-latency', 'server-suite', 'server-integration', 'body-suite'];
  for (const name of critical) {
    assert.equal(jobs[name]['runs-on'], 'ubuntu-latest');
  }
  for (const [name, job] of Object.entries(jobs)) {
    assert.ok(!JSON.stringify(job['runs-on']).includes('beeline-ci-shard'), name);
  }
});

test('PR heavy jobs use GitHub-hosted Linux runners', () => {
  for (const name of ['server-suite-shard', 'typecheck', 'mobile-suite']) {
    assert.equal(jobs[name]['runs-on'], 'ubuntu-latest', name);
  }
  const mobile = jobs['mobile-suite'].steps.find((step) => step.name === 'Run the mobile vitest suite');
  assert.match(mobile.run, /--maxWorkers=2 --minWorkers=2/);
  assert.equal(jobs['mobile-suite']['timeout-minutes'], 20);
  const fingerprint = jobs['native-fingerprint'];
  const edit = fingerprint.steps.find((step) => step.env?.BEELINE_FINGERPRINT_E2E != null);
  assert.ok(edit, 'the six-hash fingerprint test runs outside the mobile suite');
  assert.equal(String(edit.env.BEELINE_FINGERPRINT_E2E), '1');
  assert.match(edit.run, /nativeFingerprint\.test\.ts/);
  assert.match(edit.run, /--maxWorkers=1/);
  assert.equal(fingerprint['timeout-minutes'], 40);
  assert.equal(fingerprint['runs-on'], 'ubuntu-latest');
});

test('no workflow job targets the overloaded beeline-ci pool', () => {
  const directory = new URL('../.github/workflows/', import.meta.url);
  for (const file of readdirSync(directory).filter((file) => /\.ya?ml$/.test(file))) {
    const workflow = parse(readFileSync(new URL(file, directory), 'utf8'));
    for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
      const routing = JSON.stringify([job['runs-on'], job.strategy?.matrix]);
      assert.ok(!routing.includes('beeline-ci'), `${file}:${name} uses CI-only capacity`);
    }
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
