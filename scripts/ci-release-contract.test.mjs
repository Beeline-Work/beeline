import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

const workflow = name => parse(readFileSync(`.github/workflows/${name}.yml`, 'utf8'));
const checks = workflow('checks');
const release = workflow('unified-release');

test('merging to main triggers no workflow; PRs and manual suites keep their Checks contexts', () => {
  for (const file of readdirSync('.github/workflows').filter(file => file.endsWith('.yml'))) {
    const triggers = parse(readFileSync(`.github/workflows/${file}`, 'utf8')).on;
    assert.equal(triggers?.push, undefined, `${file} still runs on push`);
  }
  assert.ok(checks.on.pull_request); assert.ok(checks.on.workflow_dispatch); assert.ok(checks.on.workflow_call);
  assert.equal(checks.jobs['coverage-map-check'].name, 'SERVER COVERAGE MAP');
  assert.equal(checks.jobs['coverage-map-check'].if, "github.event_name == 'pull_request'");
  const mapCheck = checks.jobs['coverage-map-check'].steps.find(step => step.run?.includes('check-map'));
  assert.ok(mapCheck);
  assert.ok(checks.on.workflow_dispatch.inputs.suite.options.includes('coverage-map'));
  assert.equal(checks.jobs.typecheck.name, 'TYPECHECK');
  assert.equal(checks.jobs['shared-package-tests'].name, 'SHARED PACKAGE TESTS');
});

test('full Checks checks out the exact release SHA and never applies PR selection during release', () => {
  assert.equal(release.jobs.release_checks.uses, './.github/workflows/checks.yml');
  assert.deepEqual(release.jobs.release_checks.with, { suite: 'all', release_sha: '${{ needs.initialize.outputs.release_sha }}' });
  for (const [name, job] of Object.entries(checks.jobs)) {
    if (name === 'coverage-map-check') continue; // PR-only validation of the existing map.
    for (const step of job.steps ?? []) {
      if (step.uses === 'actions/checkout@v4') assert.equal(step.with.ref, '${{ inputs.release_sha || github.sha }}');
      if (step.run?.includes('test-selection.mjs select')) assert.match(step.if, /github.event_name == 'pull_request'/);
    }
  }
  const shard = checks.jobs['server-suite-shard'];
  assert.deepEqual(shard.strategy.matrix.shard, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(shard.strategy['fail-fast'], false);
  assert.equal(shard.steps.filter(step => step.run?.includes('node scripts/run-ci-shard.mjs')).length, 1);
  assert.equal(shard.steps.filter(step => step.run?.includes('node scripts/run-integration-shard.mjs')).length, 1);
  const timing = checks.jobs['production-corpus-replay'].steps.find(step => step.name?.startsWith('Run server wall-clock'));
  assert.match(timing.if, /github.event_name == 'pull_request'/);
});

test('every delivery leg requires successful release tests, including jobs with always or cancelled conditions', () => {
  const gate = release.jobs.release_validation;
  assert.deepEqual(gate.needs, ['initialize', 'release_checks']);
  for (const name of ['server', 'helper_linux', 'helper_macos', 'helper', 'release_proof', 'mobile_ota',
    'mobile_ota_after_proof', 'desktop_installers', 'website', 'mobile_native_android', 'mobile_native_ios']) {
    const job = release.jobs[name];
    assert.ok(job.needs.includes('release_validation'), name);
    assert.match(job.if, /needs.release_validation.result == 'success'/, name);
  }
  const final = release.jobs.release_result;
  assert.ok(final.needs.includes('release_validation'));
  assert.match(final.steps.find(step => step.id === 'result').run, /TEST_RESULT.*success.*failure_class=release-tests/);
  const build = gate.steps.find(step => step.run?.includes('build-map'));
  assert.equal(build.if, "needs.release_checks.result == 'success'");
  assert.match(build.run, /--commit "\$RELEASE_SHA" --release-run "\$GITHUB_RUN_ID"/);
  assert.match(build.run, /check-map/);
  assert.ok(gate.steps.some(step => step.run?.includes('release-test-report.mjs')));
  assert.ok(gate.steps.some(step => step.uses === 'actions/upload-artifact@v4' && step.with.name === 'server-coverage-map'));
  assert.match(final.steps.find(step => step.id === 'notification').if, /needs.release_validation.result == 'success'/);
});

test('workspace archives and provenance use the checkout SHA when a release promotes an older commit', () => {
  const action = parse(readFileSync('.github/actions/ci-workspace/action.yml', 'utf8'));
  assert.match(action.runs.steps.find(step => step.id === 'checkout').run, /git rev-parse HEAD/);
  for (const step of action.runs.steps) {
    if (step.env?.CI_BUILD_SHA) assert.equal(step.env.CI_BUILD_SHA, '${{ steps.checkout.outputs.sha }}');
    if (step.with?.key?.startsWith('ci-build-')) assert.match(step.with.key, /steps.checkout.outputs.sha/);
  }
});
