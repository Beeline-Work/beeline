import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

const jobs = parse(readFileSync(new URL('../.github/workflows/checks.yml', import.meta.url), 'utf8')).jobs;

test('PR wall-clock suites leave the quota only when the required hosted replay runs them', () => {
  const shard = jobs['server-suite-shard'].steps.find(step => /run-ci-shard/.test(step.run));
  assert.equal(shard.env.SERVER_HOSTED_TIMING,
    "${{ github.event_name == 'pull_request' && needs.changes.outputs.productionCorpusReplay == 'true' }}");
  const replay = jobs['production-corpus-replay'];
  assert.equal(replay.name, 'PRODUCTION-CORPUS REPLAY');
  assert.equal(replay['runs-on'], 'ubuntu-latest');
  assert.match(replay.if, /needs.changes.outputs.productionCorpusReplay == 'true'/);
  const timing = replay.steps.find(step => /Run server wall-clock budgets/.test(step.name));
  assert.equal(timing.if, "github.event_name == 'pull_request'");
  assert.match(timing.run, /src\/production-corpus-width.test.ts src\/phone-service.read-room-latency.test.ts src\/daemon-service.completion-latency.test.ts --maxWorkers=1 --minWorkers=1/);
  assert.equal(timing['continue-on-error'], undefined);
});

test('release recovery uses trusted hosted code with job reads and success delivery', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/release-failure.yml', import.meta.url), 'utf8'));
  assert.deepEqual(workflow.on.workflow_run.workflows, ['Unified production release', 'Release preflight']);
  assert.match(workflow.jobs.triage.if, /"success"/);
  assert.equal(workflow.jobs.triage['runs-on'], 'ubuntu-latest');
  assert.equal(workflow.permissions.actions, 'read');
  assert.equal(workflow.permissions.issues, 'write');
  const steps = workflow.jobs.triage.steps;
  assert.equal(steps[0].with.ref, '${{ github.event.repository.default_branch }}');
  assert.match(steps[1].with.script, /recoverFailures/);
  assert.doesNotMatch(JSON.stringify(steps), /download-artifact/);
});

test('adapter failure intake keeps the check failing and uses trusted code and exact installed versions', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/acp-adapters.yml', import.meta.url), 'utf8'));
  const job = workflow.jobs.adapters;
  assert.equal(job.permissions.issues, 'write');
  assert.equal(job.steps[0].with.ref, '${{ github.event.repository.default_branch }}');
  const check = job.steps.find(step => step.id === 'adapter_check');
  assert.equal(check.shell, 'bash'); // Explicit bash enables pipefail, preserving the check's exit code through tee.
  assert.match(check.run, /node scripts\/check-acp-adapters.mjs \| tee/);
  assert.equal(check['continue-on-error'], undefined);
  const intake = job.steps.at(-1);
  assert.equal(intake.if, "failure() && steps.adapter_check.outcome == 'failure'");
  assert.equal(intake.uses, 'actions/github-script@v7');
  assert.match(intake.with.script, /reportAdapterFailures/);
  assert.ok(job.steps.some(step => /npm list -g --depth=0 --json/.test(step.run)));
  assert.ok(Object.values(jobs).some(job => job.steps?.some(step => step.run === 'node --test --test-concurrency=1 scripts/acp-adapter-issue.test.mjs')));
});

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
  const listing = readFileSync(new URL('./play-publish-listing.sh', import.meta.url), 'utf8');
  assert.match(listing, /commit_edit "\$EDIT_ID" send-for-review/);
  const listingStep = steps.find((step) => step.run === 'bash scripts/play-publish-listing.sh');
  assert.equal(listingStep.if, 'inputs.publish_listing');
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
  const tasks = readFileSync(new URL('./ci-workspace-tasks.sh', import.meta.url), 'utf8');
  assert.match(tasks, new RegExp(`--exclude ${file.replaceAll('.', '\\.')}`));
  assert.ok(mobile.needs.includes('typecheck'));
  assert.match(JSON.stringify(mobile.steps), /needs.typecheck.outputs/);
  assert.match(isolated['runs-on'], /beeline-ci/);
  assert.equal(isolated['timeout-minutes'], 5);
  assert.equal(mobile['timeout-minutes'], 5);
  assert.ok(tasks.includes(`npx vitest run ${file} --maxWorkers=1 --minWorkers=1`));
  assert.match(JSON.stringify(isolated.steps), /needs.typecheck.outputs/);
  assert.equal(isolated['continue-on-error'], undefined);
  assert.match(tasks, /npm run fingerprint:check/);

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

const heavyJobs = ['server-suite-shard'];
const workspaceJobs = ['typecheck'];
const controlJobs = ['changes', 'prepare-workspace', 'shared-package-tests', 'server-test-selection',
  'mobile-suite', 'dead-code', 'mobile-export-reachability', 'native-fingerprint',
  'server-suite', 'server-integration', 'frame-budget', 'state-upgrade',
  'readme-parity', 'app-link-associations'];
const squireJobs = [...heavyJobs, ...workspaceJobs, ...controlJobs];
const preparedConsumers = [...heavyJobs, ...workspaceJobs, 'shared-package-tests', 'production-corpus-replay', 'app-link-associations'];

test('privileged setup and isolated PostgreSQL stay hosted', () => {
  for (const name of ['server-claim-latency', 'production-corpus-replay', 'body-suite', 'auth-image', 'actionlint']) {
    assert.equal(jobs[name]['runs-on'], 'ubuntu-latest');
  }
  for (const name of controlJobs) assert.equal(jobs[name].env.CI_TEST_WORKERS, '1', name);
});

test('only credential-free PR Linux jobs use the bounded CI-only pool', () => {
  for (const name of squireJobs) {
    const routing = jobs[name]['runs-on'];
    assert.match(routing, /github.event_name == 'pull_request'/, name);
    const labels = JSON.parse(routing.match(/fromJSON\('([^']+)'\)/)[1]);
    assert.deepEqual(labels, ['self-hosted', 'Linux', 'X64', 'beeline-ci', `beeline-ci-${controlJobs.includes(name) ? 'control' : workspaceJobs.includes(name) ? 'workspace' : 'heavy'}`], name);
    assert.match(routing, /\|\| 'ubuntu-latest'/, name);
  }
  const tasks = readFileSync(new URL('./ci-workspace-tasks.sh', import.meta.url), 'utf8');
  assert.match(tasks, /--maxWorkers=2 --minWorkers=1 --exclude sources\/config\/nativeFingerprint.test.ts/);
  const workflow = parse(readFileSync(new URL('../.github/workflows/checks.yml', import.meta.url), 'utf8'));
  assert.equal(workflow.env.CI_TEST_WORKERS, '2');
  assert.equal(workflow.env.UV_THREADPOOL_SIZE, '1');
  assert.equal(workflow.env.TURBO_CONCURRENCY, '1');
  assert.match(tasks, /--max-workers 1/);
});

test('every PR Linux Vitest command bounds both worker limits', () => {
  for (const [name, job] of [...Object.entries(jobs), ['workspace-tasks', {steps:[{run:readFileSync(new URL('./ci-workspace-tasks.sh', import.meta.url), 'utf8')}]}]]) {
    if (name === 'mac-helper-acceptance' || name.endsWith('-on-demand')) continue;
    for (const step of job.steps ?? []) {
      for (const command of (step.run ?? '').split(/\n| && /)) {
        if (!/npx vitest run|npm test /.test(command)) continue;
        assert.match(command, /--maxWorkers=(?:"\$CI_TEST_WORKERS"|[12])/, `${name}: ${command}`);
        assert.match(command, /--minWorkers=1/, `${name}: ${command}`);
      }
    }
  }
});

test('no other workflow or job gains access to CI-only capacity', () => {
  const directory = new URL('../.github/workflows/', import.meta.url);
  for (const file of readdirSync(directory).filter((file) => /\.ya?ml$/.test(file))) {
    const workflow = parse(readFileSync(new URL(file, directory), 'utf8'));
    for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
      if (file === 'checks.yml' && squireJobs.includes(name)) continue;
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

test('eight server shards retain all eight integration batches exactly once and fail closed', () => {
  const shard = jobs['server-suite-shard'];
  assert.deepEqual(shard.strategy.matrix.shard, [1, 2, 3, 4, 5, 6, 7, 8]);
  const integration = shard.steps.find((step) => step.name === 'Run one bounded integration batch');
  assert.ok(integration);
  assert.match(integration.run, /"\$SHARD\/8"/);
  assert.equal((integration.run.match(/run-integration-shard\.mjs/g) ?? []).length, 1);
  for (const gate of ['server-suite', 'server-integration']) {
    assert.ok(jobs[gate].needs.includes('server-suite-shard'));
    assert.match(JSON.stringify(jobs[gate].steps), /needs.server-suite-shard.result/);
    assert.match(JSON.stringify(jobs[gate].steps), /success/);
  }
});

test('every PR Linux workspace consumer waits for the shared preparation job', () => {
  for (const [name, job] of Object.entries(jobs)) {
    // Other operating systems and dispatch-only host lanes populate separate caches.
    if (name === 'prepare-workspace' || name.endsWith('-on-demand') || (job['runs-on'] !== 'ubuntu-latest' && !squireJobs.includes(name))) continue;
    if (!job.steps?.some((step) => step.uses === './.github/actions/ci-workspace')) continue;
    const needs = Array.isArray(job.needs) ? job.needs : [job.needs];
    assert.ok(needs.includes('prepare-workspace'), `${name} races cache preparation`);
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

test('the network admission CI command runs without duplicate package-script worker flags', () => {
  const step = jobs['shared-package-tests'].steps.find(step => step.name === 'Prove local network admission');
  const result = spawnSync('bash', ['-c', step.run], {
    cwd: new URL(`../${step['working-directory'] ?? ''}/`, import.meta.url),
    env: { ...process.env, ...step.env, CI_TEST_WORKERS: '1' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('prepared consumers cannot fan out cold installs or builds after a preparation failure', () => {
  const action = parse(readFileSync(new URL('../.github/actions/ci-workspace/action.yml', import.meta.url), 'utf8'));
  const directory = mkdtempSync(join(tmpdir(), 'ci-preparation-'));
  try {
    const marker = join(directory, 'npm-called');
    writeFileSync(join(directory, 'npm'), '#!/bin/sh\nprintf "%s\\n" "$*" > "$NPM_MARKER"\n', { mode: 0o755 });
    const steps = action.runs.steps.filter(step => /\bnpm (?:ci|run build)\b/.test(step.run ?? ''));
    assert.equal(steps.length, 3, 'root, build and mobile fallbacks must be covered');
    for (const step of steps) {
      const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, NPM_MARKER: marker, CI_PREPARED: 'true' };
      const missing = spawnSync('bash', ['-c', step.run], { env, encoding: 'utf8' });
      assert.equal(missing.status, 1, `prepared consumer must fail before ${step.run}`);
      assert.equal(existsSync(marker), false, 'a consumer must never install or rebuild');
      assert.equal(step.env.CI_PREPARED, '${{ inputs.prepared }}');
      const producer = spawnSync('bash', ['-c', step.run], { env: { ...env, CI_PREPARED: 'false' }, encoding: 'utf8' });
      assert.equal(producer.status, 0, producer.stderr);
      assert.ok(existsSync(marker), 'the producer must still prepare a cold cache');
      rmSync(marker);
    }
    for (const name of preparedConsumers) {
      const setup = jobs[name].steps.find(step => step.uses === './.github/actions/ci-workspace');
      assert.equal(setup.with.prepared, "${{ github.event_name == 'pull_request' }}", name);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test('cache tar operations wait for the shared lock while tool probes remain free', { skip: process.platform !== 'linux' }, async () => {
  const wrapper = new URL('../.github/actions/ci-workspace/bin/tar', import.meta.url);
  assert.ok(existsSync(wrapper), 'the cache tar wrapper must be installed');
  const directory = mkdtempSync(join(tmpdir(), 'ci-tar-lock-'));
  const lock = join(directory, 'lock');
  const archive = join(directory, 'cache.tar');
  writeFileSync(join(directory, 'fixture'), 'cache fixture');
  assert.equal(spawnSync('/usr/bin/tar', ['-cf', archive, '-C', directory, 'fixture']).status, 0);
  const holder = spawn('/usr/bin/flock', [lock, 'sh', '-c', 'echo held; cat >/dev/null']);
  let listing;
  try {
    await once(holder.stdout, 'data');
    const env = { ...process.env, BEELINE_CI_TAR_LOCK: lock };
    const probe = spawnSync(wrapper.pathname, ['--version'], { env, encoding: 'utf8', timeout: 2000 });
    assert.equal(probe.status, 0, probe.stderr);
    listing = spawn(wrapper.pathname, ['-tf', archive], { env });
    let finished = false;
    const completed = once(listing, 'exit').then(([code]) => { finished = true; return code; });
    await delay(100);
    assert.equal(finished, false, 'cache extraction must wait while another job holds the lock');
    holder.stdin.end();
    assert.equal(await completed, 0);
    const action = parse(readFileSync(new URL('../.github/actions/ci-workspace/action.yml', import.meta.url), 'utf8'));
    const install = action.runs.steps.find(step => step.run?.includes('$GITHUB_ACTION_PATH/bin'));
    assert.equal(install.if, "startsWith(runner.name, 'beeline-ci-squire-')");
  } finally {
    holder.stdin.end(); holder.kill(); listing?.kill();
    rmSync(directory, { recursive: true, force: true });
  }
});


test('compiled cache snapshots reject missing exports before publishing', () => {
  const action = parse(readFileSync(new URL('../.github/actions/ci-workspace/action.yml', import.meta.url), 'utf8'));
  const check = action.runs.steps.find(step => step.id === 'verify-builds');
  const restore = action.runs.steps.find(step => step.id === 'builds');
  const save = action.runs.steps.find(step => step.uses === 'actions/cache/save@v4');
  assert.equal(restore.uses, 'actions/cache/restore@v4');
  assert.equal(save.with.path, restore.with.path);
  assert.equal(save.with.key, '${{ steps.builds.outputs.cache-primary-key }}');
  assert.ok(action.runs.steps.indexOf(save) > action.runs.steps.indexOf(check));
  const directory = mkdtempSync(join(tmpdir(), 'ci-build-export-'));
  try {
    const pkg = join(directory, 'packages/api-contract');
    mkdirSync(join(pkg, 'dist'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ exports: { './mobile-minimum': {
      import: './dist/mobile-minimum.js', types: './dist/mobile-minimum.d.ts',
    } } }));
    const missing = spawnSync('bash', ['-c', check.run], { cwd: directory, encoding: 'utf8' });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /Missing compiled API export/);
    writeFileSync(join(pkg, 'dist/mobile-minimum.js'), 'export {};');
    writeFileSync(join(pkg, 'dist/mobile-minimum.d.ts'), 'export {};');
    const complete = spawnSync('bash', ['-c', check.run], { cwd: directory, encoding: 'utf8' });
    assert.equal(complete.status, 0, complete.stderr);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
