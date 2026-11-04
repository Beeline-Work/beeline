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
    "${{ (github.event_name == 'pull_request' || github.event_name == 'push') && needs.changes.outputs.productionCorpusReplay == 'true' }}");
  const replay = jobs['production-corpus-replay'];
  assert.equal(replay.name, 'PRODUCTION-CORPUS REPLAY');
  assert.equal(replay['runs-on'], 'ubuntu-latest');
  assert.match(replay.if, /needs.changes.outputs.productionCorpusReplay == 'true'/);
  const timing = replay.steps.find(step => /Run server wall-clock budgets/.test(step.name));
  assert.equal(timing.if, "github.event_name == 'pull_request' || github.event_name == 'push'");
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
  const runner = readFileSync(new URL('./run-workspace-tests.mjs', import.meta.url), 'utf8');
  assert.match(runner, /args.push\('--exclude', 'sources\/config\/nativeFingerprint.test.ts'\)/);
  assert.match(tasks, /node scripts\/run-workspace-tests.mjs mobile/);
  assert.ok(mobile.needs.includes('prepare-workspace'));
  assert.equal(mobile.steps[0].uses, 'actions/checkout@v4');
  assert.match(JSON.stringify(mobile.steps), /timeout 20m bash scripts\/ci-workspace-tasks.sh mobile-suite/);
  assert.match(isolated['runs-on'], /needs.changes.outputs.runner_native/);
  assert.equal(isolated['timeout-minutes'], 20);
  assert.match(JSON.stringify(isolated.steps), /timeout 15m bash scripts\/ci-workspace-tasks.sh native-fingerprint/);
  assert.equal(mobile['timeout-minutes'], 25);
  assert.ok(tasks.includes(`npx vitest run ${file} --maxWorkers=1 --minWorkers=1`));
  assert.ok(isolated.needs.includes('prepare-workspace'));
  assert.equal(isolated.steps[0].uses, 'actions/checkout@v4');
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
      .replaceAll('needs.prepare-workspace.outputs.mobile', 'false')
      .replaceAll('cancelled()', String(cancelled));
    return Function(`return (${expression});`)();
  }
  for (const event of ['pull_request', 'merge_group', 'push', 'workflow_dispatch']) {
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

const heavyJobs = ['server-suite-shard', 'typecheck', 'shared-package-tests', 'dead-code', 'mobile-export-reachability', 'native-fingerprint'];
const workspaceJobs = ['mobile-suite'];
const controlJobs = ['changes', 'prepare-workspace', 'server-test-selection',
  'server-suite', 'server-integration', 'frame-budget', 'state-upgrade',
  'readme-parity', 'app-link-associations'];
const squireJobs = [...heavyJobs, ...workspaceJobs, ...controlJobs];
const preparedConsumers = [...heavyJobs, ...workspaceJobs, 'production-corpus-replay', 'app-link-associations'];

test('privileged setup and isolated PostgreSQL stay hosted', () => {
  for (const name of ['server-claim-latency', 'production-corpus-replay', 'body-suite', 'auth-image', 'actionlint']) {
    assert.equal(jobs[name]['runs-on'], 'ubuntu-latest');
  }
  for (const name of controlJobs) assert.equal(jobs[name].env.CI_TEST_WORKERS, '1', name);
});

test('only credential-free PR Linux jobs use the bounded CI-only pool', () => {
  assert.equal(jobs.changes['runs-on'], 'ubuntu-latest', 'routing must never wait on squire');
  assert.equal(jobs.changes.permissions.actions, 'read');
  const routingStep = jobs.changes.steps.find(step => step.id === 'route');
  assert.equal(routingStep.run, 'node scripts/ci-runner-routing.mjs');
  assert.equal(routingStep.env.GH_TOKEN, '${{ secrets.CI_RUNNER_INVENTORY_TOKEN || github.token }}');
  for (const name of [...squireJobs.filter(name => name !== 'changes'), 'main-coverage-map']) {
    const routing = jobs[name]['runs-on'];
    if (name === 'server-suite-shard') {
      assert.match(routing, /matrix.target/);
      assert.match(jobs[name].strategy.matrix.include, /needs.changes.outputs.serverMatrix/);
      assert.match(jobs[name].services.postgres.image, /matrix.hosted/);
      continue;
    }
    const output = routing.match(/needs.changes.outputs.(runner_\w+)/)?.[1];
    assert.ok(output, `${name} must consume an explicit placement`);
    assert.ok(jobs.changes.outputs[output], `${name} has no routing output`);
    assert.match(routing, /ubuntu-latest/, `${name} must have a safe fallback`);
    const needs = Array.isArray(jobs[name].needs) ? jobs[name].needs : [jobs[name].needs];
    assert.ok(needs.includes('changes'), name);
  }
  const tasks = readFileSync(new URL('./ci-workspace-tasks.sh', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('./run-workspace-tests.mjs', import.meta.url), 'utf8');
  assert.match(runner, /workers <= 2/);
  assert.ok(runner.includes('`--maxWorkers=${workers}`'));
  assert.ok(runner.includes("'--minWorkers=1'"));
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
      if (file === 'checks.yml' && (squireJobs.includes(name) || name === 'main-coverage-map')) continue;
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

test('every main merge runs full checks and publishes one coverage map without cancelling earlier merges', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/checks.yml', import.meta.url), 'utf8'));
  assert.deepEqual(workflow.on.push.branches, ['main']);
  assert.equal(workflow.concurrency['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}");
  const main = jobs['main-coverage-map'];
  assert.equal(main.if, "github.event_name == 'push'");
  assert.match(main['runs-on'], /needs.changes.outputs.runner_coverage/);
  assert.ok(main.needs.includes('server-suite-shard'));
  assert.ok(main.needs.includes('production-corpus-replay'));
  assert.match(JSON.stringify(main.steps), /test-selection.mjs check-map/);
  assert.match(JSON.stringify(main.steps), /"name":"server-coverage-map"/);
  for (const name of ['server-suite-shard', 'production-corpus-replay']) {
    assert.ok(jobs[name].steps.some(step => /SERVER_COVERAGE_MAP_DIR=/.test(step.run ?? '')));
    assert.ok(jobs[name].steps.some(step => step.uses === 'actions/upload-artifact@v4' && /server-coverage-records/.test(step.with?.name)));
  }
  const legacy = parse(readFileSync(new URL('../.github/workflows/server-coverage-map.yml', import.meta.url), 'utf8'));
  assert.equal(legacy.on.push, undefined, 'main must not execute a duplicate full server suite');
  assert.equal(legacy.on.schedule, undefined);
  assert.deepEqual(legacy.jobs.shard.strategy.matrix.shard, [1, 2, 3, 4]);
  const run = legacy.jobs.shard.steps.find(step => step.env?.SERVER_COVERAGE_MAP_DIR);
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

test('cache eviction recovers dependencies only after successful preparation and propagates install failures', () => {
  const action = parse(readFileSync(new URL('../.github/actions/ci-workspace/action.yml', import.meta.url), 'utf8'));
  const directory = mkdtempSync(join(tmpdir(), 'ci-preparation-'));
  try {
    const marker = join(directory, 'npm-called');
    writeFileSync(join(directory, 'npm'), '#!/bin/sh\nprintf "%s\\n" "$*" > "$NPM_MARKER"\nexit "${NPM_RESULT:-0}"\n', { mode: 0o755 });
    const guard = action.runs.steps.find(step => step.name === 'Require successful shared preparation');
    assert.ok(guard, 'failed preparation must still stop consumers before recovery');
    assert.equal(guard.if, "inputs.prepared == 'true'");
    assert.equal(guard.env.CI_PREPARATION_RESULT, '${{ inputs.preparation-result }}');
    const steps = action.runs.steps.filter(step => /\bnpm ci\b/.test(step.run ?? ''));
    assert.equal(steps.length, 2, 'root and mobile dependency fallbacks must be covered');
    for (const step of steps) {
      const env = { ...process.env, HOME: directory, PATH: `${directory}:${process.env.PATH}`,
        RUNNER_NAME: process.platform === 'linux' ? 'beeline-ci-squire-fixture' : 'hosted-fixture',
        NPM_MARKER: marker, CI_PREPARED: 'true', NPM_RESULT: '0' };
      assert.equal(step.env.CI_PREPARED, '${{ inputs.prepared }}');
      assert.equal(step.env.npm_config_jobs, '1');
      for (const result of ['', 'failure', 'cancelled', 'skipped']) {
        const failed = spawnSync('bash', ['-e', '-c', `${guard.run}\n${step.run}`], {
          env: { ...env, CI_PREPARATION_RESULT: result }, encoding: 'utf8' });
        assert.equal(failed.status, 1, `preparation ${result} must prevent installation`);
        assert.equal(existsSync(marker), false);
      }
      const recovery = spawnSync('bash', ['-e', '-c', `${guard.run}\n${step.run}`], {
        env: { ...env, CI_PREPARATION_RESULT: 'success' }, encoding: 'utf8' });
      assert.equal(recovery.status, 0, recovery.stderr);
      assert.match(recovery.stdout, /::warning::/);
      assert.match(readFileSync(marker, 'utf8'), /^ci .*--prefer-offline/);
      assert.equal(spawnSync('bash', ['-c', step.run], {
        env: { ...env, NPM_RESULT: '23' }, encoding: 'utf8' }).status, 23,
      'a failed recovery must fail setup');
      rmSync(marker);
      const producer = spawnSync('bash', ['-c', step.run], {
        env: { ...env, CI_PREPARED: 'false', RUNNER_NAME: 'hosted-fixture' }, encoding: 'utf8' });
      assert.equal(producer.status, 0, producer.stderr);
      assert.ok(existsSync(marker), 'cold producer and hosted installs remain supported');
      rmSync(marker);
    }
    for (const name of preparedConsumers) {
      const setup = jobs[name].steps.find(step => step.uses === './.github/actions/ci-workspace');
      assert.equal(setup.with.prepared, ['dead-code', 'native-fingerprint', 'mobile-export-reachability'].includes(name) ? 'true' : "${{ github.event_name == 'pull_request' || github.event_name == 'push' }}", name);
      assert.equal(setup.with['preparation-result'], '${{ needs.prepare-workspace.result }}', name);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test('simultaneous dependency cache misses serialize cold installs on squire', { skip: process.platform !== 'linux' }, async () => {
  const action = parse(readFileSync(new URL('../.github/actions/ci-workspace/action.yml', import.meta.url), 'utf8'));
  const install = action.runs.steps.find(step => /npm ci --no-audit/.test(step.run ?? ''));
  const directory = mkdtempSync(join(tmpdir(), 'ci-install-lock-'));
  const children = [];
  try {
    const marker = join(directory, 'installs');
    const release = join(directory, 'release');
    writeFileSync(join(directory, 'npm'), `#!/bin/sh
set -eu
printf 'started\\n' >> "$NPM_MARKER"
printf 'started\\n'
while [ ! -f "$INSTALL_RELEASE" ]; do sleep 0.02; done
`, { mode: 0o755 });
    const env = { ...process.env, HOME: directory, PATH: `${directory}:${process.env.PATH}`,
      RUNNER_NAME: 'beeline-ci-squire-fixture', CI_PREPARED: 'true', NPM_MARKER: marker, INSTALL_RELEASE: release };
    const first = spawn('bash', ['-e', '-c', install.run], { env }); children.push(first);
    // The warning is printed before locking; wait for the stub's marker too.
    for (let i = 0; i < 200 && !existsSync(marker); i++) await delay(10);
    assert.ok(existsSync(marker), 'first install must acquire its lock');
    const firstExit = once(first, 'exit');
    const second = spawn('bash', ['-e', '-c', install.run], { env }); children.push(second);
    const secondExit = once(second, 'exit');
    await delay(100);
    assert.equal(readFileSync(marker, 'utf8'), 'started\n', 'a second consumer must wait outside npm');
    writeFileSync(release, 'release');
    assert.equal((await firstExit)[0], 0);
    assert.equal((await secondExit)[0], 0);
    assert.equal(readFileSync(marker, 'utf8'), 'started\nstarted\n');
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    rmSync(directory, { recursive: true, force: true });
  }
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

test('a prepared rerun rebuilds missing compiled exports when its build cache disappeared', () => {
  const action = parse(readFileSync(new URL('../.github/actions/ci-workspace/action.yml', import.meta.url), 'utf8'));
  const build = action.runs.steps.find(step => /npm run build/.test(step.run ?? ''));
  const verify = action.runs.steps.find(step => step.id === 'verify-builds');
  assert.equal(build.if, "steps.builds.outputs.cache-hit != 'true'", 'warm consumers keep reusing the exact-commit cache');
  const directory = mkdtempSync(join(tmpdir(), 'ci-evicted-build-'));
  try {
    const pkg = join(directory, 'packages/api-contract');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ exports: { './mobile-minimum': {
      import: './dist/mobile-minimum.js', types: './dist/mobile-minimum.d.ts',
    } } }));
    const before = spawnSync('bash', ['-c', verify.run], { cwd: directory, encoding: 'utf8' });
    assert.notEqual(before.status, 0, 'the fresh checkout must reproduce the missing export');
    const marker = join(directory, 'build-arguments');
    writeFileSync(join(directory, 'npm'), `#!/bin/sh
set -eu
printf '%s\\n' "$*" > "$BUILD_MARKER"
mkdir -p "$FIXTURE_PACKAGE/dist"
printf 'export {};\\n' > "$FIXTURE_PACKAGE/dist/mobile-minimum.js"
printf 'export {};\\n' > "$FIXTURE_PACKAGE/dist/mobile-minimum.d.ts"
`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`,
      CI_PREPARED: 'true', FIXTURE_PACKAGE: pkg, BUILD_MARKER: marker };
    const rebuilt = spawnSync('bash', ['-c', build.run], { cwd: directory, env, encoding: 'utf8' });
    assert.equal(rebuilt.status, 0, rebuilt.stderr);
    assert.equal(readFileSync(marker, 'utf8').trim(), 'run build -- --concurrency=1');
    const after = spawnSync('bash', ['-c', verify.run], { cwd: directory, encoding: 'utf8' });
    assert.equal(after.status, 0, after.stderr);
    writeFileSync(join(directory, 'npm'), '#!/bin/sh\nexit 23\n', { mode: 0o755 });
    assert.equal(spawnSync('bash', ['-c', build.run], { cwd: directory, env }).status, 23,
      'a failed rebuild must still fail setup');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('integration survives an ordinary test failure but never runs against failed workspace setup', () => {
  const steps = jobs['server-suite-shard'].steps;
  const workspace = steps.find(step => step.uses === './.github/actions/ci-workspace');
  const integration = steps.find(step => step.name === 'Run one bounded integration batch');
  assert.equal(workspace.id, 'workspace');
  const evaluate = new Function('cancelled', 'github', 'inputs', 'steps',
    `return (${integration.if.replace(/^\$\{\{\s*|\s*\}\}$/g, '')});`);
  for (const workspaceOutcome of ['success', 'failure', 'skipped']) {
    for (const suiteOutcome of ['success', 'failure']) {
      assert.equal(evaluate(() => false, { event_name: 'pull_request' }, {}, {
        workspace: { outcome: workspaceOutcome }, suite: { outcome: suiteOutcome },
      }), workspaceOutcome === 'success');
    }
  }
  assert.equal(evaluate(() => true, { event_name: 'pull_request' }, {}, {
    workspace: { outcome: 'success' },
  }), false, 'cancellation still stops integration');
});

test('cross-commit task caches never replace exact-head final artifact provenance', () => {
  const action = parse(readFileSync(new URL('../.github/actions/ci-workspace/action.yml', import.meta.url), 'utf8'));
  const taskCache = action.runs.steps.find(step => step.with?.path === '.turbo/cache');
  assert.ok(taskCache.with['restore-keys']);
  assert.match(taskCache.with.key, /github.job/);
  const final = action.runs.steps.find(step => step.id === 'builds');
  assert.equal(final.with['restore-keys'], undefined);
  assert.match(final.with.key, /github.sha/);
  assert.match(final.with.path, /\.beeline-ci-build.json/);
  assert.doesNotMatch(final.with.path, /\.turbo/);
  const verify = action.runs.steps.findIndex(step => /ci-build-provenance.mjs verify/.test(step.run ?? ''));
  const publish = action.runs.steps.findIndex(step => step.uses === 'actions/cache/save@v4');
  assert.ok(verify > 0 && verify < publish, 'all consumers verify exact output hashes before use/publication');
  assert.equal(action.runs.steps[verify]['continue-on-error'], undefined);
  const turbo = JSON.parse(readFileSync(new URL('../turbo.json', import.meta.url), 'utf8'));
  assert.equal(turbo.tasks.test.cache, false, 'database/performance/test verdicts must execute');
});

test('independent companion checks own their checkout without changing execution caps', () => {
  for (const [name, minutes] of [['dead-code', 15], ['native-fingerprint', 15], ['mobile-export-reachability', 30]]) {
    const job = jobs[name];
    assert.ok(job.needs.includes('prepare-workspace'));
    assert.equal(job.needs.includes('typecheck'), false);
    assert.equal(job.steps[0].uses, 'actions/checkout@v4');
    assert.ok(job.steps.some(step => step.run === `timeout ${minutes}m bash scripts/ci-workspace-tasks.sh ${name}`));
  }
  assert.equal(jobs.typecheck.env.RUN_DEAD_CODE, 'false');
  assert.equal(jobs.typecheck.env.RUN_NATIVE_FINGERPRINT, 'false');
  assert.equal(jobs.typecheck.env.RUN_MOBILE_EXPORT, 'false');
});

test('PR coverage selection runs independently of Body/mobile full fallback and workspace preparation', () => {
  const selection = jobs['server-test-selection'];
  assert.equal(selection.needs, 'changes');
  const evaluate = new Function('github', 'needs', `return (${selection.if.replace(/needs\.([a-z][a-z0-9-]*)/g, "needs['$1']")});`);
  for (const mode of ['full', 'subset']) for (const code of ['true', 'false']) {
    const needs = { changes: { outputs: { code } }, 'prepare-workspace': { outputs: { mode } } };
    assert.equal(evaluate({ event_name: 'pull_request' }, needs), code === 'true');
    assert.equal(evaluate({ event_name: 'push' }, needs), false);
  }
  const select = selection.steps.find(step => step.id === 'select');
  assert.match(select.run, /test-selection.mjs select/);
  assert.doesNotMatch(select.run, /WORKSPACE_MODE/);
  assert.match(jobs['server-suite-shard'].if, /!cancelled\(\)/);
  assert.equal(jobs['server-suite-shard'].steps.find(step => step.name === "Use this PR's server test selection").if,
    "needs.server-test-selection.outputs.selection != ''");
});

test('warm test-only jobs avoid unused task archives, but every missing build can reuse tasks', () => {
  const action = parse(readFileSync(new URL('../.github/actions/ci-workspace/action.yml', import.meta.url), 'utf8'));
  const task = action.runs.steps.find(step => step.with?.path === '.turbo/cache');
  const evaluate = new Function('steps', 'github', 'contains', 'fromJSON', `return (${task.if.replaceAll('.cache-hit', "['cache-hit']")});`);
  for (const hit of ['true', 'false']) for (const job of ['prepare-workspace', 'typecheck', 'dead-code', 'mac-helper-acceptance', 'server-suite-shard', 'mobile-suite', 'production-corpus-replay']) {
    assert.equal(evaluate({ builds: { outputs: { 'cache-hit': hit } } }, { job }, (values, value) => values.includes(value), JSON.parse),
      hit !== 'true' || ['typecheck', 'dead-code', 'mac-helper-acceptance'].includes(job));
  }
  const state = action.runs.steps.find(step => step.with?.path === 'apps/mobile/tsconfig.tsbuildinfo');
  assert.equal(state.if, "inputs.mobile == 'true' && github.job == 'typecheck'");
  assert.ok(action.runs.steps.findIndex(step => step.id === 'builds') < action.runs.steps.indexOf(task));
});
