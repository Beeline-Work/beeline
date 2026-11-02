import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

const jobs = parse(readFileSync(new URL('../.github/workflows/checks.yml', import.meta.url), 'utf8')).jobs;

test('Android binary releases publish to production, completed, and send the build for review', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/unified-release.yml', import.meta.url), 'utf8'));
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.store_track.options, ['none', 'production', 'beta']);
  const steps = workflow.jobs.mobile_native_android.steps;
  const upload = steps.find((step) => step.id === 'play-upload');
  // Even selection=mobile-native with store_track=none must publish its Android binary.
  assert.equal(upload.if, "steps.android_build.outcome == 'success'");
  assert.equal(upload.env.TRACK, "${{ inputs.store_track == 'beta' && 'beta' || 'production' }}");
  // All omitted/default/recovery inputs select production. Only explicit beta opts out.
  for (const track of ['', 'none', 'production', 'beta']) {
    const expression = upload.env.TRACK.slice(3, -2).replaceAll('inputs.store_track', JSON.stringify(track));
    assert.equal(Function(`return (${expression})`)(), track === 'beta' ? 'beta' : 'production');
  }
  assert.match(upload.run, /RELEASE_STATUS=completed bash scripts\/play-publish.sh/);
  assert.equal(upload.env.PLAY_DEFER_COMMIT, '1');
  const commit = steps.find((step) => step.run === 'bash scripts/play-commit-build.sh');
  assert.equal(commit.if, "steps.play-upload.outputs.edit_id != ''");
  assert.equal(commit.env.PLAY_LISTING_BASELINE, upload.env.PLAY_LISTING_BASELINE);
  assert.ok(steps.indexOf(commit) > steps.indexOf(upload));
  const gate = readFileSync(new URL('./play-commit-build.sh', import.meta.url), 'utf8');
  assert.ok(gate.indexOf('play-listing-lock.mjs" verify') < gate.indexOf('commit_edit'));
  assert.match(gate, /commit_edit "\$PLAY_EDIT_ID" send-for-review/);
  assert.doesNotMatch(gate, /hold-for-review/);
  const helper = readFileSync(new URL('./play-api.sh', import.meta.url), 'utf8');
  const review = helper.slice(helper.indexOf('if [ "${2:-}" = "send-for-review" ]'), helper.indexOf('if [ "${PLAY_DRY_RUN:-0}"', helper.indexOf('commit_edit()')));
  assert.match(review, /:commit\?changesInReviewBehavior=ERROR_IF_IN_REVIEW/);
  assert.doesNotMatch(review, /changesNotSentForReview/);
  const eas = JSON.parse(readFileSync(new URL('../apps/mobile/eas.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(eas.submit), ['production', 'beta']);
  assert.equal(eas.submit.production.android.track, 'production');
  assert.equal(eas.submit.production.android.releaseStatus, 'completed');
  assert.equal(eas.submit.production.android.changesNotSentForReview, false);
  assert.equal(eas.submit.beta.android.track, 'beta');
  assert.equal(eas.submit.beta.android.releaseStatus, 'completed');
  assert.equal(eas.submit.beta.android.changesNotSentForReview, false);
});

test('excluding the fingerprint regression from the mobile suite always has isolated coverage', () => {
  const mobile = jobs['mobile-suite'];
  const isolated = jobs['native-fingerprint'];
  const file = 'sources/config/nativeFingerprint.test.ts';
  const suiteStep = mobile.steps.find((step) => step.name === 'Run the mobile vitest suite');
  assert.ok(suiteStep.run.endsWith(` --exclude ${file}`));
  assert.equal(isolated['runs-on'], 'ubuntu-latest');
  assert.equal(isolated['timeout-minutes'], 15);
  assert.equal(mobile['timeout-minutes'], 20);
  const regression = isolated.steps.find((step) => step.run ===
    `npx vitest run ${file} --maxWorkers=1 --minWorkers=1`);
  assert.ok(regression);
  assert.equal(regression['working-directory'], 'apps/mobile');
  assert.equal(regression.if, undefined);
  assert.equal(regression['continue-on-error'], undefined);
  assert.equal(isolated['continue-on-error'], undefined);
  assert.ok(isolated.steps.some((step) => step.run === 'npm run fingerprint:check'));

  // Evaluate the workflow conditions over all routing combinations, including
  // string-valued path-filter outputs, so a future narrowing cannot drop coverage.
  function selected(job, event, suite, mobileSuite, nativeFingerprint, cancelled) {
    const expression = job.if
      .replaceAll('github.event_name', JSON.stringify(event))
      .replaceAll('inputs.suite', JSON.stringify(suite))
      .replaceAll('needs.changes.outputs.mobileSuite', JSON.stringify(String(mobileSuite)))
      .replaceAll('needs.changes.outputs.nativeFingerprint', JSON.stringify(String(nativeFingerprint)))
      .replaceAll('cancelled()', String(cancelled));
    return Function(`return (${expression});`)();
  }
  for (const event of ['pull_request', 'merge_group', 'workflow_dispatch']) {
    for (const suite of ['all', 'mobile-suite', 'native-fingerprint', 'typecheck']) {
      for (const mobileSuite of [false, true]) {
        for (const nativeFingerprint of [false, true]) {
          for (const cancelled of [false, true]) {
            const args = [event, suite, mobileSuite, nativeFingerprint, cancelled];
            if (selected(mobile, ...args)) {
              assert.ok(selected(isolated, ...args), JSON.stringify(args));
            }
          }
        }
      }
    }
  }
  assert.ok(selected(isolated, 'workflow_dispatch', 'native-fingerprint', false, false, false));
});

test('preparation, verdicts and the timing-sensitive PostgreSQL budget stay hosted', () => {
  const critical = ['changes', 'shared-package-tests', 'server-test-selection', 'server-claim-latency', 'server-suite', 'server-integration', 'body-suite'];
  for (const name of critical) {
    assert.equal(jobs[name]['runs-on'], 'ubuntu-latest');
  }
  for (const [name, job] of Object.entries(jobs)) {
    if (job.uses) continue;
    assert.ok(!JSON.stringify(job['runs-on']).includes('beeline-ci-shard'), name);
  }
});

test('PR heavy jobs use GitHub-hosted Linux runners', () => {
  for (const name of ['server-suite-shard', 'typecheck', 'mobile-suite']) {
    assert.equal(jobs[name]['runs-on'], 'ubuntu-latest', name);
  }
  const mobile = jobs['mobile-suite'].steps.find((step) => step.name === 'Run the mobile vitest suite');
  assert.match(mobile.run, /--maxWorkers=2 --minWorkers=2/);
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

test('every hosted Linux workspace consumer waits for the shared preparation job', () => {
  for (const [name, job] of Object.entries(jobs)) {
    // Other operating systems and dispatch-only host lanes populate separate caches.
    if (name === 'shared-package-tests' || job['runs-on'] !== 'ubuntu-latest') continue;
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

test('a PR runs only selected server tests, and anything without a selection runs them all', () => {
  const selection = jobs['server-test-selection'];
  assert.match(selection.if, /github.event_name == 'pull_request'/);
  assert.doesNotMatch(selection.if, /merge_group|workflow_dispatch/);
  const shard = jobs['server-suite-shard'];
  assert.ok(shard.needs.includes('server-test-selection'));
  // A failed or skipped selection must not skip the shards: they run every file.
  assert.match(shard.if, /!cancelled\(\)/);
  const use = shard.steps.find((step) => step.name === "Use this PR's server test selection");
  assert.equal(use.if, "needs.server-test-selection.outputs.selection != ''");
  assert.match(use.run, /SERVER_TEST_SELECTION=/);
  for (const name of ['SERVER SUITE', 'SERVER INTEGRATION']) {
    assert.ok(Object.values(jobs).some((job) => job.name === name), name);
  }
});

test('the coverage map follows main pushes without a schedule and checks source-text tests', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/server-coverage-map.yml', import.meta.url), 'utf8'));
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.equal(workflow.on.schedule, undefined);
  assert.equal(workflow.concurrency['cancel-in-progress'], true);
  const steps = JSON.stringify(workflow.jobs.map.steps);
  assert.match(steps, /test-selection.mjs check-map/);
  assert.match(steps, /"name":"server-coverage-map"/);
  const shard = workflow.jobs.shard;
  assert.deepEqual(shard.strategy.matrix.shard, [1, 2, 3, 4]);
  const run = shard.steps.find((step) => step.env?.SERVER_COVERAGE_MAP_DIR);
  assert.match(run.run, /"\$SHARD\/8"/);
  assert.match(run.run, /"\$\(\(SHARD \+ 4\)\)\/8"/);
  assert.equal(jobs['coverage-map'].uses, './.github/workflows/server-coverage-map.yml');
});
