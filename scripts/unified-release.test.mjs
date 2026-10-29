import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import test from 'node:test';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { NPM_VISIBILITY_TIMEOUT_MS } from './npm-package-visibility.mjs';
import {
  applyComponentCheckpoints,
  changedPathsFromPublishedInputs,
  checkpointsFromJobs,
  classifyReleaseAttempt,
  desktopLagFromPublishedInputs,
  DESKTOP_UI_REFRESH_SECONDS,
  COMPONENT_PATH_RULES,
  SERVER_CANARY_SAMPLES,
  SERVER_CANARY_WINDOW_SECONDS,
  DESKTOP_VERSION_BASELINE,
  createServerImageLedger,
  evaluateServerCanarySample,
  evaluateServerCanaryPromotion,
  evaluateServerCanaryWindow,
  RELEASE_SOFT_LIMIT_SECONDS,
  RELEASE_COMPONENTS,
  RELEASE_NOTIFY_TIMEOUT_MS,
  RELEASE_NOTIFY_ENDPOINT,
  finalizeRelease,
  initializeRelease,
  markComponentStage,
  notifyRelease,
  planServerCanaryDeployment,
  releasePlanSummary,
  runtimePinChangeFromPublishedInputs,
  retryPlan,
  selectReleaseComponents,
  selectReleaseComponentsFromPublishedInputs,
  selectServerRollbackImage,
  releaseVersionForSource,
} from './unified-release.mjs';

const OLD_SHA = '1'.repeat(40);
const MID_SHA = '3'.repeat(40);
const NEW_SHA = '2'.repeat(40);
const RELEASE_SCRIPT = fileURLToPath(new URL('./unified-release.mjs', import.meta.url));

test('OTA retry downloads the earlier candidate and recovers only its exact production groups', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/unified-release.yml', import.meta.url), 'utf8'));
  const action = parse(readFileSync(new URL('../.github/actions/mobile-ota-leg/action.yml', import.meta.url), 'utf8'));
  const reuse = action.runs.steps.find((step) => step.id === 'reuse');
  const promoteDownload = action.runs.steps.find((step) =>
    step.uses === 'actions/download-artifact@v4' && step.if === "inputs.phase == 'promote'");
  const promote = action.runs.steps.find((step) => step.id === 'promotion');
  assert.match(reuse.if, /inputs\.phase == 'promote'/);
  assert.match(reuse.with.script, /listArtifactsForRepo/);
  assert.match(promoteDownload.with['run-id'], /steps\.reuse\.outputs\.run_id/);
  assert.ok(promoteDownload.with['github-token']);
  assert.match(promote.run, /recover-promotion/);
  assert.match(promote.run, /retry-attempt/);
  assert.match(promote.run, /if \[ "\$\(cat "\$RUNNER_TEMP\/mobile-ota-recovery.txt"\)" = new \]/);
  for (const job of ['mobile_ota', 'mobile_ota_after_native']) {
    assert.equal(workflow.jobs[job]['timeout-minutes'], 18);
    assert.equal(workflow.jobs[job].steps[0].with.ref, '${{ needs.initialize.outputs.release_sha }}');
    // A recovery of an attempted identity only recovers its exact promotion.
    for (const leg of workflow.jobs[job].steps.filter((step) => step.uses === './.github/actions/mobile-ota-leg')) {
      assert.equal(leg.with.retry_attempt, "${{ needs.initialize.outputs.stage_mobile_ota == 'promoted' && '2' || '1' }}");
    }
    // The marker is its own step before the promote leg, so a job that fails
    // mid-promotion still reports it.
    const steps = workflow.jobs[job].steps;
    const marker = steps.findIndex((step) => step.id === 'promote_started');
    assert.ok(marker >= 0 && marker === steps.findIndex((step) => step.id === 'promote') - 1);
    assert.equal(workflow.jobs[job].outputs.promote_started, '${{ steps.promote_started.outputs.started }}');
  }
  assert.equal(workflow.jobs.initialize.outputs.stage_mobile_ota, '${{ steps.plan.outputs.stage_mobile_ota }}');

  const dir = mkdtempSync(join(tmpdir(), 'ota-recovery-'));
  try {
    const ledgerPath = join(dir, 'ledger.json');
    const indexPath = join(dir, 'index.json');
    const resultPath = join(dir, 'result.txt');
    const mockPath = join(dir, 'eas.cjs');
    const targetList = [
      { platform: 'android', runtimeVersion: '31', group: 'beta-android' },
      { platform: 'ios', runtimeVersion: '31', group: 'beta-ios' },
    ];
    const baseLedger = {
      schemaVersion: 2, status: 'beta', sourceSha: NEW_SHA, releaseVersion: 'v0.0.128',
      candidateTargets: targetList, updateTargets: targetList.map(({ platform, runtimeVersion }) => ({ platform, runtimeVersion })),
      delivery: { state: 'built', runId: '36277001426', attempt: 1 },
    };
    const baseIndex = { schemaVersion: 1, merges: [{ sha: NEW_SHA, state: 'built', attempts: [] }] };
    const listed = targetList.map((target) => ({
      group: `production-${target.platform}`, runtimeVersion: target.runtimeVersion,
      platforms: target.platform,
      message: `"promote beta ${target.group} (${NEW_SHA.slice(0, 12)})" (55 minutes ago by lunchboxfortwo)`,
    }));
    writeFileSync(mockPath, '#!/usr/bin/env node\nprocess.stdout.write(process.env.MOCK_EAS_LIST);\n');
    chmodSync(mockPath, 0o755);
    const run = (payload) => spawnSync(process.execPath, [
      'scripts/ota-release.mjs', 'recover-promotion', '--ledger', ledgerPath,
      '--index', indexPath, '--result', resultPath, '--retry-attempt', '3', '--run-id', '36290000000',
    ], {
      cwd: fileURLToPath(new URL('../apps/mobile/', import.meta.url)), encoding: 'utf8',
      env: { ...process.env, EAS_CLI_PATH: mockPath, MOCK_EAS_LIST: JSON.stringify({ name: 'production', currentPage: payload }) },
    });
    writeFileSync(ledgerPath, JSON.stringify(baseLedger));
    writeFileSync(indexPath, JSON.stringify(baseIndex));
    const recovered = run(listed);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(readFileSync(resultPath, 'utf8'), 'recovered\n');
    assert.equal(JSON.parse(readFileSync(ledgerPath)).status, 'production');
    assert.deepEqual(JSON.parse(readFileSync(indexPath)).merges[0].published.groupIds.sort(),
      ['production-android', 'production-ios']);
    assert.equal(JSON.parse(readFileSync(indexPath)).merges[0].attempts[0].runId, '36290000000');
    for (const command of ['assert-promotion', 'assert-production-list']) {
      const verified = spawnSync(process.execPath, [
        'scripts/ota-release.mjs', command, '--ledger', ledgerPath, '--index', indexPath,
      ], {
        cwd: fileURLToPath(new URL('../apps/mobile/', import.meta.url)), encoding: 'utf8',
        env: { ...process.env, EAS_CLI_PATH: mockPath, MOCK_EAS_LIST: JSON.stringify({ name: 'production', currentPage: listed }) },
      });
      assert.equal(verified.status, 0, `${command}: ${verified.stderr}`);
    }

    // Reproduction pinned-ota-recovery: a recovery whose earlier attempt never
    // started promotion runs at attempt 1, so an empty production list
    // promotes the exact candidate instead of refusing.
    const runAt = (attempt, payload) => spawnSync(process.execPath, [
      'scripts/ota-release.mjs', 'recover-promotion', '--ledger', ledgerPath,
      '--index', indexPath, '--result', resultPath, '--retry-attempt', attempt, '--run-id', '36290000000',
    ], {
      cwd: fileURLToPath(new URL('../apps/mobile/', import.meta.url)), encoding: 'utf8',
      env: { ...process.env, EAS_CLI_PATH: mockPath, MOCK_EAS_LIST: JSON.stringify({ name: 'production', currentPage: payload }) },
    });
    writeFileSync(ledgerPath, JSON.stringify(baseLedger));
    writeFileSync(indexPath, JSON.stringify(baseIndex));
    const unstarted = runAt('1', []);
    assert.equal(unstarted.status, 0, unstarted.stderr);
    assert.equal(readFileSync(resultPath, 'utf8'), 'new\n');
    // A started promotion (attempt 2) still refuses to republish blindly.
    const started = runAt('2', []);
    assert.notEqual(started.status, 0);
    assert.match(started.stderr, /refusing to republish on a retry/);

    writeFileSync(ledgerPath, JSON.stringify(baseLedger));
    writeFileSync(indexPath, JSON.stringify(baseIndex));
    const missing = run(listed.map((target) => ({ ...target, message: 'different release' })));
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /refusing to republish on a retry/);
    assert.equal(JSON.parse(readFileSync(ledgerPath)).status, 'beta');
    const partial = run([{ ...listed[0] }, { ...listed[1], message: 'different release' }]);
    assert.notEqual(partial.status, 0);
    assert.match(partial.stderr, /Only 1\/2 exact OTA targets are current/);
    assert.equal(JSON.parse(readFileSync(ledgerPath)).status, 'beta');
    const prefixOnly = run(listed.map((target) => ({
      ...target, message: target.message.replace('" (55 minutes', ' with different bytes" (55 minutes'),
    })));
    assert.notEqual(prefixOnly.status, 0);
    assert.match(prefixOnly.stderr, /refusing to republish on a retry/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the release planner reads its desktop migration floor from the Tauri version file', () => {
  const desktopVersion = JSON.parse(readFileSync(
    new URL('../apps/mobile/src-tauri/desktop-version.json', import.meta.url), 'utf8',
  )).version;
  assert.equal(DESKTOP_VERSION_BASELINE, desktopVersion);
});

test('run 36105533369 succeeds with OTA at 10 minutes and the whole run at 28.5 minutes', () => {
  const triggerEpoch = 1_700_000_000;
  const replay = classifyReleaseAttempt({
    triggerEpoch,
    finishedEpoch: triggerEpoch + (28.5 * 60),
    checkpoints: [{ component: 'mobile-ota', state: 'checked', completedAt: triggerEpoch + (10 * 60) }],
  });
  assert.deepEqual(replay, {
    outcome: 'success',
    failureClass: '',
    otaElapsedSeconds: 600,
    wholeRunElapsedSeconds: 1710,
    softLimitSeconds: RELEASE_SOFT_LIMIT_SECONDS,
    slow: false,
    otaCompletedAt: triggerEpoch + 600,
  });

  const slow = classifyReleaseAttempt({
    triggerEpoch,
    finishedEpoch: triggerEpoch + RELEASE_SOFT_LIMIT_SECONDS + 1,
    checkpoints: [{ component: 'mobile-ota', state: 'checked', completedAt: triggerEpoch + 600 }],
  });
  assert.equal(slow.outcome, 'success');
  assert.equal(slow.failureClass, '');
  assert.equal(slow.slow, true);
});

test('a release that shipped every component succeeds however late its OTA landed', () => {
  // Run 541 shape: OTA completed long after dispatch, but nothing is unfinished.
  const triggerEpoch = 1_700_000_000;
  const late = classifyReleaseAttempt({
    triggerEpoch,
    finishedEpoch: triggerEpoch + (150 * 60),
    checkpoints: [{ component: 'mobile-ota', state: 'checked', completedAt: triggerEpoch + (90 * 60) }],
  });
  assert.equal(late.outcome, 'success');
  assert.equal(late.failureClass, '');
  assert.equal(late.otaElapsedSeconds, 90 * 60);
  assert.equal(late.slow, true);
  assert.equal('budgetSeconds' in late, false);

  const missingCompletion = classifyReleaseAttempt({
    triggerEpoch,
    finishedEpoch: triggerEpoch + 1800,
    checkpoints: [{ component: 'mobile-ota', state: 'checked' }],
  });
  assert.equal(missingCompletion.otaElapsedSeconds, 1800);
  assert.equal(missingCompletion.outcome, 'success');
});

test('only an unfinished component fails a release attempt', () => {
  const triggerEpoch = 1_700_000_000;
  const incomplete = classifyReleaseAttempt({
    triggerEpoch,
    finishedEpoch: triggerEpoch + 60,
    checkpoints: [{ component: 'mobile-ota', state: 'checked', completedAt: triggerEpoch + 30 }],
    incomplete: 'helper,website',
  });
  assert.equal(incomplete.outcome, 'failure');
  assert.equal(incomplete.failureClass, 'component:helper,website');
  assert.equal(incomplete.slow, false);
});

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', timeout: 10_000 });
}

function writeFixture(root, path, contents) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function deliveredPrevious() {
  return {
    schemaVersion: 2,
    version: 'v0.0.8',
    sourceSha: OLD_SHA,
    state: 'delivered',
    components: Object.fromEntries(RELEASE_COMPONENTS.map((component) => [component, {
      state: 'checked',
      selected: true,
      version: 'v0.0.8',
      sourceSha: OLD_SHA,
      artifactRef: `${component}-v0.0.8-${OLD_SHA}`,
      ...(component === 'desktop' ? { desktopVersion: '0.2.20' } : {}),
    }])),
  };
}

test('server canary plan migrates, updates one Machine, watches, then updates its peer', () => {
  const machines = [
    { id: 'b-machine', config: { image: 'registry.fly.io/beeline-server:old' } },
    { id: 'a-machine', config: { image: 'registry.fly.io/beeline-server:old' } },
  ];
  const plan = planServerCanaryDeployment(machines, 'registry.fly.io/beeline-server:new');
  assert.deepEqual(plan.steps, [
    'migrate',
    'update:a-machine:registry.fly.io/beeline-server:new',
    'watch:a-machine:90s',
    'update:b-machine:registry.fly.io/beeline-server:new',
  ]);
  assert.deepEqual(plan.rollbackSteps, [
    'update:a-machine:registry.fly.io/beeline-server:old',
    'fail-release',
  ]);
  assert.equal(plan.split, false);
  assert.throws(() => planServerCanaryDeployment(machines.slice(0, 1), 'registry.fly.io/beeline-server:new'), /exactly two/);
});

test('reproduces #542: a fleet split by an interrupted release converges on the new image', () => {
  const plan = planServerCanaryDeployment([
    { id: 'b', config: { image: 'registry.fly.io/beeline-server:0.1.100' } },
    { id: 'a', config: { image: 'registry.fly.io/beeline-server:0.1.99' } },
  ], 'registry.fly.io/beeline-server:0.1.101');
  assert.equal(plan.split, true);
  assert.deepEqual(plan.steps, [
    'migrate',
    'update:a:registry.fly.io/beeline-server:0.1.101',
    'watch:a:90s',
    'update:b:registry.fly.io/beeline-server:0.1.101',
  ]);
  // Each Machine returns to the image it ran before this release.
  assert.deepEqual(plan.rollbackSteps, [
    'update:a:registry.fly.io/beeline-server:0.1.99',
    'update:b:registry.fly.io/beeline-server:0.1.100',
    'fail-release',
  ]);
  assert.equal(plan.previousImageRef, 'registry.fly.io/beeline-server:0.1.99');
  assert.equal(plan.secondPreviousImageRef, 'registry.fly.io/beeline-server:0.1.100');
});

test('server canary samples and the bounded window fail closed', () => {
  const clean = evaluateServerCanarySample({
    health: {
      ok: true,
      database: {
        pool: { size: 10, inUse: 2, waiting: 0 },
        oldestActiveQueryAgeMs: 42,
      },
    },
    roomRead: { ok: true, status: 200 },
    version: { version: 'v0.0.9', sourceSha: NEW_SHA },
    expectedVersion: 'v0.0.9', expectedSha: NEW_SHA,
  });
  assert.equal(clean.clean, true);
  assert.equal(clean.poolMetricsAvailable, true);
  const cleanIdlePool = evaluateServerCanarySample({
    health: {
      ok: true,
      database: {
        pool: { size: 0, inUse: 0, waiting: 0 },
        oldestActiveQueryAgeMs: null,
      },
    },
    roomRead: { ok: true, status: 200 },
    version: { version: 'v0.0.9', sourceSha: NEW_SHA },
    expectedVersion: 'v0.0.9', expectedSha: NEW_SHA,
  });
  assert.equal(cleanIdlePool.clean, true);
  assert.equal(cleanIdlePool.poolMetricsAvailable, true);
  assert.deepEqual(cleanIdlePool.pool, {
    size: 0, inUse: 0, waiting: 0, oldestActiveQueryAgeMs: null,
  });
  assert.equal(evaluateServerCanarySample({
    health: {
      ok: true,
      database: {
        pool: { size: 10, inUse: 10, waiting: 3 },
        oldestActiveQueryAgeMs: 4_999,
      },
    },
    roomRead: { ok: true, status: 200 },
    version: { version: 'v0.0.9', sourceSha: NEW_SHA },
    expectedVersion: 'v0.0.9', expectedSha: NEW_SHA,
  }).clean, false);
  const missingPoolMetrics = evaluateServerCanarySample({
    health: { ok: true, database: { oldestActiveQueryAgeMs: null } },
    roomRead: { ok: true, status: 200 },
    version: { version: 'v0.0.9', sourceSha: NEW_SHA },
    expectedVersion: 'v0.0.9', expectedSha: NEW_SHA,
  });
  assert.equal(missingPoolMetrics.clean, false);
  assert.equal(missingPoolMetrics.poolMetricsAvailable, false);
  assert.match(missingPoolMetrics.reasons[0], /omitted database pool diagnostics/);
  const samples = [0, 300].map((seconds) => ({
    at: new Date(Date.UTC(2026, 8, 12, 12, 0, seconds)).toISOString(), verdict: clean,
  }));
  assert.deepEqual(evaluateServerCanaryWindow(samples), {
    clean: true, elapsedSeconds: 300, poolMetricsAvailable: true,
  });
  assert.equal(evaluateServerCanaryWindow(samples.map((sample, index) => index ? {
    ...sample, verdict: { clean: false, reasons: ['Room read failed'] },
  } : sample)).clean, false);
});

test('server promotion needs sustained clean samples and rejects a late relapse', () => {
  const start = Date.UTC(2026, 8, 27, 12);
  const sample = (index, verdict = { clean: true, reasons: [] }) => ({
    at: new Date(start + index * 15_000).toISOString(), verdict,
  });
  assert.equal(SERVER_CANARY_WINDOW_SECONDS, 90);
  assert.equal(SERVER_CANARY_SAMPLES, 7);
  const clean = Array.from({ length: 7 }, (_, index) => sample(index));
  assert.deepEqual(evaluateServerCanaryPromotion(clean), {
    clean: true, cleanCount: 7, elapsedSeconds: 90,
  });
  const oneClean = clean.map((entry, index) => index === 0 ? entry :
    sample(index, { clean: false, reasons: ['authenticated Room read returned HTTP 503'] }));
  assert.match(evaluateServerCanaryPromotion(oneClean).reason, /only 1 of 7/);
  const lateRelapse = [...clean];
  lateRelapse[6] = sample(6, { clean: false, reasons: ['database pool has 2 waiter(s)'] });
  assert.match(evaluateServerCanaryPromotion(lateRelapse).reason, /final three/);
  const sustained = [...clean];
  for (const index of [1, 2])
    sustained[index] = sample(index, { clean: false, reasons: ['database pool has 1 waiter(s)'] });
  assert.match(evaluateServerCanaryPromotion(sustained).reason, /sustained pool wait/);
  const warmup = [...clean];
  for (const index of [0, 2])
    warmup[index] = sample(index, { clean: false, reasons: ['health endpoint is not ok'] });
  assert.equal(evaluateServerCanaryPromotion(warmup).clean, true);
  assert.equal(evaluateServerCanaryPromotion(clean.slice(1)).clean, false);
  const short = clean.map((entry, index) => ({ ...entry, at: new Date(start + index * 10_000).toISOString() }));
  assert.match(evaluateServerCanaryPromotion(short).reason, /full 90-second window/);

  const action = parse(readFileSync(new URL('../.github/actions/server-leg/action.yml', import.meta.url), 'utf8'));
  const promotion = action.runs.steps.find((step) =>
    typeof step.run === 'string' && step.run.includes('server-canary-promotion'));
  assert.ok(promotion, 'Machine promotion must use the sustained verdict');
  assert.doesNotMatch(promotion.run, /canary_ever_clean/);
});

test('server image ledger pins the automatic and manual rollback image', () => {
  const plan = planServerCanaryDeployment([
    { id: 'a', imageRef: 'registry.fly.io/beeline-server:old' },
    { id: 'b', imageRef: 'registry.fly.io/beeline-server:old' },
  ], 'registry.fly.io/beeline-server:new');
  const ledger = createServerImageLedger({ version: 'v0.0.9', sourceSha: NEW_SHA, plan });
  assert.equal(ledger.previousImageRef, 'registry.fly.io/beeline-server:old');
  assert.equal(selectServerRollbackImage({ ledger }), ledger.previousImageRef);
  assert.equal(selectServerRollbackImage({
    explicitImageRef: 'registry.fly.io/beeline-server:named', ledger,
  }), 'registry.fly.io/beeline-server:named');
  assert.throws(() => selectServerRollbackImage({ ledger: {} }), /no valid previous/);
});

test('server deployment plan prints both success and rollback ordering', () => {
  const root = mkdtempSync(join(tmpdir(), 'beeline-canary-plan-'));
  try {
    const machines = join(root, 'machines.json');
    writeFileSync(machines, JSON.stringify([
      { id: 'a', config: { image: 'registry.fly.io/beeline-server:old' } },
      { id: 'b', config: { image: 'registry.fly.io/beeline-server:old' } },
    ]));
    const output = run('node', [RELEASE_SCRIPT, 'server-deploy-plan', '--machines', machines,
      '--image', 'registry.fly.io/beeline-server:new'], root);
    assert.match(output, /^migrate -> update:a:.*:new -> watch:a:90s -> update:b:.*:new/m);
    assert.match(output, /on failure: update:a:.*:old -> fail-release/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('component selection follows the explicit path map', () => {
  assert.deepEqual(selectReleaseComponents(['apps/server/src/index.ts']), ['server']);
  assert.deepEqual(selectReleaseComponents(['apps/body/src/index.ts']), ['helper']);
  assert.deepEqual(selectReleaseComponents(['web/index.html']), ['website']);
  assert.deepEqual(selectReleaseComponents(['docs/operator.md']), []);
  assert.deepEqual(selectReleaseComponents([], { selection: 'server,mobile-ota' }), [
    'server',
    'mobile-ota',
  ]);
  assert.deepEqual(selectReleaseComponents([], { selection: 'all' }), RELEASE_COMPONENTS);
  assert.throws(() => selectReleaseComponents([], { selection: 'everything' }), /unknown release component/);
});

test('shared protocol and shared UI paths fan out to their actual consumers', () => {
  assert.deepEqual(
    selectReleaseComponents(['packages/api-contract/src/phone.ts']),
    ['server', 'helper', 'mobile-ota'],
  );
  // A mobile-sources-only diff ships by OTA and the website, never desktop.
  assert.deepEqual(
    selectReleaseComponents(['apps/mobile/sources/components/Ledger.tsx']),
    ['mobile-ota', 'website'],
  );
  assert.deepEqual(selectReleaseComponents(['apps/mobile/assets/images/icon.png']), ['mobile-ota', 'website']);
  assert.deepEqual(selectReleaseComponents(['packages/nostr/src/index.ts']), ['helper', 'mobile-ota']);
  assert.deepEqual(selectReleaseComponents(['apps/mobile/src-tauri/src/main.rs']), ['desktop']);
  assert.deepEqual(selectReleaseComponents([], { selection: 'desktop' }), ['desktop']);
  // A pipeline-file-only diff never rebuilds the helper or desktop.
  assert.deepEqual(
    selectReleaseComponents(['.github/workflows/unified-release.yml', 'scripts/unified-release.mjs']),
    ['server', 'mobile-ota', 'website'],
  );
  assert.deepEqual(
    selectReleaseComponents(['apps/mobile/app.config.js']),
    ['mobile-ota', 'desktop', 'website'],
  );
  assert.deepEqual(
    selectReleaseComponents(['apps/mobile/scripts/ota-release.mjs']),
    ['mobile-ota'],
  );
});

test('desktop catches up with shared UI once its bundled UI is a week behind', () => {
  const uiOnly = Object.fromEntries(RELEASE_COMPONENTS.map((component) => [
    component, ['apps/mobile/sources/components/Ledger.tsx'],
  ]));
  assert.deepEqual(selectReleaseComponentsFromPublishedInputs(uiOnly, {
    desktopLagSeconds: DESKTOP_UI_REFRESH_SECONDS - 1,
  }), ['mobile-ota', 'website']);
  assert.deepEqual(selectReleaseComponentsFromPublishedInputs(uiOnly, {
    desktopLagSeconds: DESKTOP_UI_REFRESH_SECONDS,
  }), ['mobile-ota', 'desktop', 'website']);
  // Age alone never rebuilds desktop: only lagging UI it bundles does.
  const serverOnly = Object.fromEntries(RELEASE_COMPONENTS.map((component) => [component, ['apps/server/src/index.ts']]));
  assert.deepEqual(selectReleaseComponentsFromPublishedInputs(serverOnly, {
    desktopLagSeconds: 10 * DESKTOP_UI_REFRESH_SECONDS,
  }), ['server']);
  const times = { [OLD_SHA]: 1_000, [NEW_SHA]: 1_000 + DESKTOP_UI_REFRESH_SECONDS };
  assert.equal(desktopLagFromPublishedInputs(deliveredPrevious(), NEW_SHA, { commitTime: (sha) => times[sha] }),
    DESKTOP_UI_REFRESH_SECONDS);
});

test('each component job result is its release checkpoint', () => {
  const identity = { version: 'v0.0.9', sourceSha: NEW_SHA, releaseId: `v0.0.9-${NEW_SHA}` };
  const needs = (overrides = {}) => ({
    initialize: { result: 'success', outputs: {
      run_server: 'true', run_helper: 'false', run_mobile_ota: 'true', run_mobile_native: 'true',
      run_desktop: 'true', run_website: 'true', native_android: 'true', native_ios: 'false',
    } },
    server: { result: 'success', outputs: {} },
    helper: { result: 'skipped', outputs: {} },
    mobile_ota: { result: 'skipped', outputs: {} },
    mobile_ota_after_native: { result: 'success', outputs: { completed_at: '1700000600' } },
    mobile_native_android: { result: 'success', outputs: {} },
    mobile_native_ios: { result: 'skipped', outputs: {} },
    desktop_installers: { result: 'failure', outputs: {} },
    website: { result: 'success', outputs: {} },
    ...overrides,
  });
  assert.deepEqual(checkpointsFromJobs(needs(), identity), [
    { component: 'server', version: 'v0.0.9', sourceSha: NEW_SHA, state: 'checked', artifactRef: `server-artifact-v0.0.9-${NEW_SHA}` },
    { component: 'mobile-ota', version: 'v0.0.9', sourceSha: NEW_SHA, state: 'checked',
      artifactRef: `mobile-ota-promoted-v0.0.9-${NEW_SHA}`, completedAt: 1_700_000_600 },
    { component: 'website', version: 'v0.0.9', sourceSha: NEW_SHA, state: 'checked', artifactRef: `website-v0.0.9-${NEW_SHA}` },
    { component: 'mobile-native', version: 'v0.0.9', sourceSha: NEW_SHA, state: 'checked', artifactRef: `mobile-native-v0.0.9-${NEW_SHA}` },
  ]);
  // An OTA job that failed after production promotion started records it.
  const promotedOta = checkpointsFromJobs(needs({
    mobile_ota_after_native: { result: 'failure', outputs: { promote_started: 'true' } },
  }), identity).find((checkpoint) => checkpoint.component === 'mobile-ota');
  assert.equal(promotedOta.state, 'promoted');
  // One that failed before promotion leaves the OTA pending.
  assert.ok(!checkpointsFromJobs(needs({
    mobile_ota_after_native: { result: 'failure', outputs: { promote_started: '' } },
  }), identity).some((checkpoint) => checkpoint.component === 'mobile-ota'));
  // A required native platform that did not build leaves mobile-native unchecked.
  assert.ok(!checkpointsFromJobs(needs({ mobile_native_android: { result: 'failure', outputs: {} } }), identity)
    .some((checkpoint) => checkpoint.component === 'mobile-native'));
  // The applied checkpoints leave exactly the failed component unfinished.
  const state = initializeRelease({ version: 'v0.0.9', sourceSha: NEW_SHA });
  applyComponentCheckpoints(state, checkpointsFromJobs(needs({
    helper: { result: 'success', outputs: {} },
    initialize: { result: 'success', outputs: { ...needs().initialize.outputs, run_helper: 'true' } },
  }), identity));
  assert.deepEqual(Object.entries(retryPlan(state)).filter(([, open]) => open).map(([component]) => component), ['desktop']);
});

test('routine auto selection catches lagging consumers from each published component sha', () => {
  const pathsByComponent = {
    server: [],
    helper: ['apps/server/src/index.ts', 'apps/mobile/sources/components/Ledger.tsx'],
    'mobile-ota': ['apps/server/src/index.ts', 'apps/mobile/sources/components/Ledger.tsx'],
    'mobile-native': ['apps/server/src/index.ts', 'apps/mobile/sources/components/Ledger.tsx'],
    desktop: ['apps/server/src/index.ts', 'apps/mobile/sources/components/Ledger.tsx'],
    website: ['apps/server/src/index.ts', 'apps/mobile/sources/components/Ledger.tsx'],
  };

  assert.deepEqual(selectReleaseComponentsFromPublishedInputs(pathsByComponent), [
    'mobile-ota',
    'website',
  ]);
  assert.equal(releaseVersionForSource(deliveredPrevious(), NEW_SHA), 'v0.0.9');
  assert.equal(releaseVersionForSource({ ...deliveredPrevious(), sourceSha: NEW_SHA }, NEW_SHA), 'v0.0.8');
});

test('routine CLI derives lagging consumers from real published git history', () => {
  const root = mkdtempSync(join(tmpdir(), 'beeline-release-test-'));
  try {
    run('git', ['init', '--quiet'], root);
    run('git', ['config', 'user.email', 'release-test@usebeeline.app'], root);
    run('git', ['config', 'user.name', 'Release Test'], root);
    writeFixture(root, 'README.md', 'baseline\n');
    writeFixture(root, 'apps/mobile/native-fingerprint.json', '{"runtimeVersion":"23"}\n');
    run('git', ['add', '.'], root);
    run('git', ['commit', '--quiet', '-m', 'baseline'], root);
    const oldSha = run('git', ['rev-parse', 'HEAD'], root).trim();

    writeFixture(root, 'apps/server/src/index.ts', 'export const server = true;\n');
    writeFixture(root, 'apps/mobile/sources/components/Ledger.tsx', 'export const ledger = true;\n');
    writeFixture(root, 'apps/mobile/app.config.js', 'export const config = true;\n');
    run('git', ['add', '.'], root);
    run('git', ['commit', '--quiet', '-m', 'server and shared ui'], root);
    const releaseSha = run('git', ['rev-parse', 'HEAD'], root).trim();

    const previous = deliveredPrevious();
    previous.sourceSha = releaseSha;
    previous.components.server = {
      ...previous.components.server,
      sourceSha: releaseSha,
      artifactRef: `server-${previous.version}-${releaseSha}`,
    };
    for (const component of RELEASE_COMPONENTS.filter((name) => name !== 'server')) {
      previous.components[component] = {
        ...previous.components[component], sourceSha: oldSha, state: 'carried', selected: false,
      };
    }
    const previousPath = join(root, 'previous.json');
    const componentPathsPath = join(root, 'component-paths.json');
    const pathsPath = join(root, 'paths.txt');
    const statePath = join(root, 'state.json');
    const summaryPath = join(root, 'summary.json');
    writeFileSync(previousPath, `${JSON.stringify(previous)}\n`);

    assert.equal(
      run('node', [RELEASE_SCRIPT, 'release-version', '--previous', previousPath, '--sha', releaseSha], root).trim(),
      previous.version,
    );
    run('node', [
      RELEASE_SCRIPT, 'component-paths', '--previous', previousPath, '--sha', releaseSha,
      '--output', componentPathsPath, '--paths-output', pathsPath,
    ], root);
    const componentPaths = JSON.parse(readFileSync(componentPathsPath, 'utf8'));
    assert.deepEqual(componentPaths.server, []);
    assert.deepEqual(componentPaths.desktop, [
      'apps/mobile/app.config.js',
      'apps/mobile/sources/components/Ledger.tsx',
      'apps/server/src/index.ts',
    ]);
    assert.deepEqual(changedPathsFromPublishedInputs(previous, releaseSha, {
      gitDiff: (from, to) => run('git', ['diff', '--name-only', from, to], root),
    }).server, []);

    run('node', [
      RELEASE_SCRIPT, 'plan', '--version', previous.version, '--sha', releaseSha,
      '--previous', previousPath, '--paths', pathsPath, '--component-paths', componentPathsPath,
      '--selection', 'auto', '--store-track', 'none', '--state', statePath, '--summary', summaryPath,
    ], root);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
    assert.deepEqual(state.plan.selected, ['mobile-ota', 'desktop', 'website']);
    assert.deepEqual(summary.selected, ['mobile-ota', 'desktop', 'website']);
    assert.equal(state.components.server.sourceSha, releaseSha);
    assert.equal(state.components.helper.sourceSha, oldSha);
    assert.ok(state.plan.selected.every((component) => state.components[component].sourceSha === releaseSha));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('routine same-head release supplements lagging shared UI consumers and retries in place', () => {
  const previous = deliveredPrevious();
  previous.sourceSha = NEW_SHA;
  previous.components.server = {
    ...previous.components.server,
    version: previous.version,
    sourceSha: NEW_SHA,
    artifactRef: `server-${previous.version}-${NEW_SHA}`,
  };
  for (const component of RELEASE_COMPONENTS.filter((name) => name !== 'server')) {
    previous.components[component] = {
      ...previous.components[component],
      state: 'carried',
      selected: false,
    };
  }
  const sharedUiPaths = ['apps/server/src/index.ts', 'apps/mobile/sources/components/Ledger.tsx'];
  const componentPaths = Object.fromEntries(RELEASE_COMPONENTS.map((component) => [
    component,
    component === 'server' ? [] : sharedUiPaths,
  ]));
  const selected = selectReleaseComponentsFromPublishedInputs(componentPaths);
  const version = releaseVersionForSource(previous, NEW_SHA);
  const state = initializeRelease({
    version,
    sourceSha: NEW_SHA,
    previous,
    selectedComponents: selected,
  });

  assert.equal(version, previous.version);
  assert.deepEqual(selected, ['mobile-ota', 'website']);
  assert.deepEqual(state.plan.selected, ['mobile-ota', 'website']);
  assert.equal(state.components.server.sourceSha, NEW_SHA);
  assert.equal(state.components.helper.sourceSha, OLD_SHA);
  for (const component of selected) {
    assert.equal(state.components[component].state, 'pending');
    assert.equal(state.components[component].sourceSha, NEW_SHA);
  }

  for (const stage of ['built', 'promoted', 'checked']) markComponentStage(state, 'mobile-ota', stage);
  const retry = initializeRelease({
    version,
    sourceSha: NEW_SHA,
    retry: state,
  });
  assert.equal(retry.components['mobile-ota'].state, 'checked');
  assert.equal(retry.components.website.state, 'pending');
  assert.deepEqual(retryPlan(retry), {
    server: false,
    helper: false,
    'mobile-ota': false,
    'mobile-native': false,
    desktop: false,
    website: true,
  });

  for (const stage of ['built', 'promoted', 'checked']) markComponentStage(retry, 'website', stage);
  finalizeRelease(retry);
  const noChanges = Object.fromEntries(RELEASE_COMPONENTS.map((component) => [component, []]));
  const noOp = initializeRelease({
    version: releaseVersionForSource(retry, NEW_SHA),
    sourceSha: NEW_SHA,
    previous: retry,
    selectedComponents: selectReleaseComponentsFromPublishedInputs(noChanges),
  });
  assert.deepEqual(noOp, retry);
});

test('R-release-timeout: routine native input changes carry binaries while recovery remains explicit', () => {
  const paths = ['apps/mobile/app.config.js', 'apps/mobile/package.json',
    'apps/mobile/package-lock.json', 'apps/mobile/android/build.gradle',
    'apps/mobile/ios/Podfile', 'apps/mobile/plugins/withNative.js'];
  const pathsByComponent = Object.fromEntries(RELEASE_COMPONENTS.map((name) => [name, paths]));
  for (const select of [
    (options) => selectReleaseComponents(paths, options),
    (options) => selectReleaseComponentsFromPublishedInputs(pathsByComponent, options),
  ]) {
    for (const selection of ['auto', '']) {
      assert.ok(!select({ selection, storeTrack: 'none' }).includes('mobile-native'));
    }
    for (const selection of ['all', 'mobile-native']) {
      assert.ok(select({ selection, storeTrack: 'none' }).includes('mobile-native'));
    }
    for (const storeTrack of ['internal', 'beta', 'production']) {
      assert.ok(select({ storeTrack }).includes('mobile-native'));
    }
    assert.throws(() => select({ runtimePin: { changed: true, previous: '23', next: '24' } }), /--store-track/);
    assert.ok(!select({ runtimePin: { changed: true, previous: '24', next: '23' },
      allowPinRestore: true }).includes('mobile-native'));
  }
});

test('R-release-timeout: workflow completes promotion and refuses unrequested native jobs', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/unified-release.yml', import.meta.url), 'utf8'));
  assert.equal(workflow.jobs.server['timeout-minutes'], 15);
  assert.equal(workflow.jobs.server.concurrency['cancel-in-progress'], false);
  const action = parse(readFileSync(new URL('../.github/actions/server-leg/action.yml', import.meta.url), 'utf8'));
  assert.ok(!action.runs.steps.some((step) => /free starter agent|stage-free-agent/.test(step.name + step.run)));
  assert.ok(!workflow.jobs.server.steps.some((step) => step.uses === 'dtolnay/rust-toolchain@stable'));
  // Starter image publishing runs after the release, never inside it.
  assert.equal(workflow.jobs.free_agent_image, undefined);
  const starter = parse(readFileSync(new URL('../.github/workflows/free-agent-image.yml', import.meta.url), 'utf8'));
  assert.deepEqual(starter.on.workflow_run, { workflows: [workflow.name], types: ['completed'] });
  const publishJob = starter.jobs.free_agent_image;
  assert.equal(publishJob.if, "github.event.workflow_run.conclusion == 'success'");
  assert.equal(publishJob['timeout-minutes'], 18);
  assert.ok(publishJob.steps.some((step) => step.uses === 'dtolnay/rust-toolchain@stable'));
  const publish = publishJob.steps.find((step) => step.name === 'Publish the free starter agent base image');
  assert.match(publish.run, /bash scripts\/stage-free-agent-helper\.sh/);
  assert.match(publish.run, /Free starter agent image was not published/);
  assert.equal(publish.env.RELEASE_SHA, '${{ steps.release.outputs.sha }}');
  const identity = publishJob.steps.find((step) => step.id === 'release');
  assert.match(identity.run, /selected\?\.includes\('server'\)/);
  const canary = action.runs.steps.find((step) => step.name === 'Canary one Machine for ninety seconds, then update its peer');
  assert.match(canary.run, /for sample in \$\(seq 0 6\)/);
  assert.match(canary.run, /sleep 15/);
  assert.equal(SERVER_CANARY_WINDOW_SECONDS, 90);
  assert.equal(SERVER_CANARY_SAMPLES, 7);
  for (const platform of ['android', 'ios']) {
    const condition = workflow.jobs[`mobile_native_${platform}`].if;
    // Evaluate the actual workflow expression with a stale native retry flag,
    // so a planner regression cannot silently start a routine store build.
    for (const storeTrack of ['', 'none', 'internal', 'beta', 'production']) {
      for (const selection of ['', 'auto', 'all', 'mobile-native']) {
        const expression = condition
          .replaceAll('needs.initialize.outputs.run_mobile_native', "'true'")
          .replaceAll(`needs.initialize.outputs.native_${platform}`, "'true'")
          .replaceAll('inputs.store_track', JSON.stringify(storeTrack))
          .replaceAll('inputs.selection', JSON.stringify(selection));
        assert.equal(Function(`return (${expression})`)(),
          !['', 'none'].includes(storeTrack) || !['', 'auto'].includes(selection));
      }
    }
  }
});

test('R-release-timeout: independent starter publishing preserves release identity and remains best effort', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/free-agent-image.yml', import.meta.url), 'utf8'));
  const publish = workflow.jobs.free_agent_image.steps.find((step) => step.name === 'Publish the free starter agent base image');
  const root = mkdtempSync(join(tmpdir(), 'starter-publish-'));
  try {
    const trace = join(root, 'trace');
    for (const command of ['bash', 'flyctl', 'docker']) {
      const script = join(root, command);
      writeFileSync(script, `#!/bin/sh
printf '%s %s %s %s\\n' '${command}' "$*" "\${BEELINE_RELEASE_SHA:-}" "\${BEELINE_RELEASE_VERSION:-}" >> "$TRACE"
if [ '${command}' = bash ] && [ "$FAIL_STAGE" = true ]; then exit 1; fi
`);
      chmodSync(script, 0o755);
    }
    for (const failStage of ['false', 'true']) {
      writeFileSync(trace, '');
      const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', publish.run], {
        cwd: root, encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, PATH: `${root}:${process.env.PATH}`, TRACE: trace,
          FAIL_STAGE: failStage, RELEASE_VERSION: 'v0.1.97', RELEASE_SHA: NEW_SHA },
      });
      assert.equal(result.status, 0, result.stderr);
      const calls = readFileSync(trace, 'utf8').trim().split('\n');
      assert.equal(calls[0], `bash scripts/stage-free-agent-helper.sh ${NEW_SHA} v0.1.97`);
      if (failStage === 'true') {
        assert.equal(calls.length, 1);
        assert.match(result.stdout, /::warning::Free starter agent image was not published/);
      } else {
        assert.equal(calls.length, 5);
        assert.match(calls[1], new RegExp(`flyctl deploy .*--build-arg BEELINE_RELEASE_SHA=${NEW_SHA}`));
        assert.match(calls[4], /docker push registry.fly.io\/beeline-free-agents:latest/);
        assert.match(result.stdout, /Published registry.fly.io\/beeline-free-agents:0.1.97-/);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('store choice explicitly selects a native mobile binary', () => {
  assert.deepEqual(
    selectReleaseComponents([], { storeTrack: 'internal' }),
    ['mobile-native'],
  );
  assert.throws(() => selectReleaseComponents([], { storeTrack: 'nightly' }), /invalid store track/);
  assert.ok(!selectReleaseComponents(['.github/workflows/unified-release.yml']).includes('mobile-native'));
});

test('runtime pin selection requires a native store submission only when the pin changes', () => {
  const unchanged = { changed: false, previous: '23', next: '23' };
  const changed = { changed: true, previous: '23', next: '24' };
  assert.deepEqual(selectReleaseComponents(['apps/mobile/sources/index.ts'], { runtimePin: unchanged }), [
    'mobile-ota', 'website',
  ]);
  assert.throws(
    () => selectReleaseComponents([], { selection: 'mobile-ota', storeTrack: 'internal', runtimePin: changed }),
    /runtime pin changed 23 -> 24: mobile-native \(store binaries\) must ship in this release; add it or revert the pin/,
  );
  assert.deepEqual(selectReleaseComponents([], { storeTrack: 'internal', runtimePin: changed }), ['mobile-native']);
});

test('runtime pin change reads the published and release trees', () => {
  const pins = runtimePinChangeFromPublishedInputs(deliveredPrevious(), NEW_SHA, {
    gitShow: (sha) => JSON.stringify({ runtimeVersion: sha === OLD_SHA ? '23' : '24' }),
  });
  assert.deepEqual(pins, {
    changed: true,
    changedPlatforms: ['android', 'ios'],
    previous: { android: '23', ios: '23' },
    next: { android: '24', ios: '24' },
  });
  const selected = selectReleaseComponents([], {
    selection: 'mobile-native', storeTrack: 'internal', runtimePin: pins,
  });
  const state = initializeRelease({
    version: 'v0.0.9', sourceSha: NEW_SHA, previous: deliveredPrevious(),
    selectedComponents: selected, runtimePin: pins,
  });
  assert.equal(state.plan.runtimePinChanged, true);
  assert.deepEqual(state.plan.previousRuntimeVersion, { android: '23', ios: '23' });
  assert.deepEqual(state.plan.nextRuntimeVersion, { android: '24', ios: '24' });
  assert.deepEqual(state.plan.nativePlatforms, ['android', 'ios']);
});

test('per-platform pins select only the changed platform native release', () => {
  for (const changed of ['android', 'ios']) {
    const pins = runtimePinChangeFromPublishedInputs(deliveredPrevious(), NEW_SHA, {
      gitShow: (sha) => JSON.stringify(sha === OLD_SHA ? { runtimeVersion: '23' } : {
        android: { runtimeVersion: changed === 'android' ? '24' : '23' },
        ios: { runtimeVersion: changed === 'ios' ? '24' : '23' },
      }),
    });
    assert.deepEqual(pins.changedPlatforms, [changed]);
    assert.throws(() => selectReleaseComponents([], { runtimePin: pins }), /--store-track/);
    assert.throws(
      () => selectReleaseComponents([], {
        selection: 'mobile-ota', storeTrack: 'internal', runtimePin: pins,
      }),
      /mobile-native/,
    );
    const selectedComponents = selectReleaseComponents([], {
      storeTrack: 'internal', runtimePin: pins,
    });
    const state = initializeRelease({
      version: 'v0.0.9', sourceSha: NEW_SHA, previous: deliveredPrevious(),
      selectedComponents, runtimePin: pins,
    });
    assert.deepEqual(state.plan.nativePlatforms, [changed]);
  }
  const unchanged = runtimePinChangeFromPublishedInputs(deliveredPrevious(), NEW_SHA, {
    gitShow: (sha) => JSON.stringify(sha === OLD_SHA ? { runtimeVersion: '23' } : {
      android: { runtimeVersion: '23' }, ios: { runtimeVersion: '23' },
    }),
  });
  assert.equal(unchanged.changed, false);
  assert.deepEqual(selectReleaseComponents([], { runtimePin: unchanged }), []);
  assert.throws(() => runtimePinChangeFromPublishedInputs(deliveredPrevious(), NEW_SHA, {
    gitShow: () => JSON.stringify({ ios: { runtimeVersion: '24' } }),
  }), /android.runtimeVersion/);
});

test('reproduces #1088: a runtime pin bump cannot plan an OTA without store binaries', () => {
  assert.throws(
    () => selectReleaseComponents(['apps/mobile/native-fingerprint.json'], {
      selection: 'auto',
      storeTrack: 'none',
      runtimePin: { changed: true, previous: '23', next: '24' },
    }),
    /runtime pin changed 23 -> 24/,
  );
});

test('allowPinRestore ships an OTA-only pin restore without mobile-native and records pinRestore', () => {
  const pins = runtimePinChangeFromPublishedInputs(deliveredPrevious(), NEW_SHA, {
    gitShow: (sha) => JSON.stringify(sha === OLD_SHA ? { runtimeVersion: '23' } : {
      android: { runtimeVersion: '24' }, ios: { runtimeVersion: '24' },
    }),
  });
  assert.equal(pins.changed, true);
  const selected = selectReleaseComponents(['apps/mobile/sources/index.ts'], {
    selection: 'auto', storeTrack: 'none', runtimePin: pins, allowPinRestore: true,
  });
  assert.ok(selected.includes('mobile-ota'));
  assert.ok(!selected.includes('mobile-native'));
  const state = initializeRelease({
    version: 'v0.0.9', sourceSha: NEW_SHA, previous: deliveredPrevious(),
    selectedComponents: selected, runtimePin: pins,
  });
  state.plan.pinRestore = true;
  assert.equal(state.plan.pinRestore, true);
  assert.deepEqual(state.plan.nativePlatforms, ['android', 'ios']);
});

test('the path map has no duplicate matcher and names only real components', () => {
  const matchers = COMPONENT_PATH_RULES.map((rule) => rule.exact ?? `${rule.prefix}*`);
  assert.equal(new Set(matchers).size, matchers.length);
  for (const rule of COMPONENT_PATH_RULES) {
    assert.ok(rule.exact || rule.prefix);
    assert.ok(rule.components.length > 0);
    for (const component of rule.components) assert.ok(RELEASE_COMPONENTS.includes(component));
  }
});

test('unchanged components carry previous version, sha, and immutable artifact reference', () => {
  const state = initializeRelease({
    version: 'v0.0.9', sourceSha: NEW_SHA, previous: deliveredPrevious(), selectedComponents: ['server'],
  });
  assert.deepEqual(state.plan.selected, ['server']);
  assert.equal(state.components.server.state, 'pending');
  for (const component of RELEASE_COMPONENTS.filter((name) => name !== 'server')) {
    assert.deepEqual(state.components[component], {
      state: 'carried',
      selected: false,
      version: 'v0.0.8',
      sourceSha: OLD_SHA,
      artifactRef: `${component}-v0.0.8-${OLD_SHA}`,
      ...(component === 'desktop' ? { desktopVersion: '0.2.20' } : {}),
    });
  }
  assert.match(releasePlanSummary(state).carried.helper, /^v0\.0\.8@1111/);
});

test('a selected desktop advances only its own monotonic version', () => {
  const state = initializeRelease({
    version: 'v0.0.9', sourceSha: NEW_SHA, previous: deliveredPrevious(), selectedComponents: ['desktop'],
  });
  assert.equal(state.components.desktop.version, 'v0.0.9');
  assert.equal(state.components.desktop.desktopVersion, '0.2.21');
  assert.equal(state.components['mobile-native'].version, 'v0.0.8');
});

test('a carried desktop version advances once after intervening non-desktop releases', () => {
  const nonDesktop = initializeRelease({
    version: 'v0.0.9', sourceSha: MID_SHA, previous: deliveredPrevious(), selectedComponents: ['server'],
  });
  nonDesktop.state = 'delivered';
  nonDesktop.components.server.state = 'checked';
  const desktop = initializeRelease({
    version: 'v0.0.10', sourceSha: NEW_SHA, previous: nonDesktop, selectedComponents: ['desktop'],
  });
  assert.equal(nonDesktop.components.desktop.desktopVersion, '0.2.20');
  assert.equal(desktop.components.desktop.desktopVersion, '0.2.21');
});

test('same-identity selection supplements only a stale carried component', () => {
  const initial = initializeRelease({
    version: 'v0.0.9', sourceSha: NEW_SHA, previous: deliveredPrevious(),
    selectedComponents: ['server', 'mobile-ota'], startedAt: '2026-09-09T12:00:00.000Z',
  });
  for (const component of ['server', 'mobile-ota']) {
    for (const stage of ['built', 'promoted', 'checked']) markComponentStage(initial, component, stage);
  }
  finalizeRelease(initial, { finishedAt: '2026-09-09T12:03:20.000Z' });
  const preserved = Object.fromEntries(RELEASE_COMPONENTS
    .filter((component) => component !== 'helper')
    .map((component) => [component, structuredClone(initial.components[component])]));

  const supplemental = initializeRelease({
    version: 'v0.0.9', sourceSha: NEW_SHA, previous: initial,
    selectedComponents: ['server', 'helper'], startedAt: '2026-09-09T13:00:00.000Z',
  });

  assert.equal(supplemental.state, 'planned');
  assert.deepEqual(supplemental.plan.selected, ['helper']);
  assert.deepEqual(retryPlan(supplemental), {
    server: false,
    helper: true,
    'mobile-ota': false,
    'mobile-native': false,
    desktop: false,
    website: false,
  });
  assert.deepEqual(supplemental.components.helper, {
    state: 'pending', selected: true, version: 'v0.0.9', sourceSha: NEW_SHA,
    artifactRef: `helper-v0.0.9-${NEW_SHA}`,
  });
  for (const [component, entry] of Object.entries(preserved)) {
    assert.deepEqual(supplemental.components[component], entry);
  }

  applyComponentCheckpoints(supplemental, [{
    component: 'helper', version: 'v0.0.9', sourceSha: NEW_SHA, state: 'checked',
    artifactRef: `helper-v0.0.9-${NEW_SHA}`,
  }]);
  finalizeRelease(supplemental, { finishedAt: '2026-09-09T13:02:00.000Z' });
  assert.equal(supplemental.state, 'delivered');
  assert.ok(RELEASE_COMPONENTS.every((component) =>
    ['checked', 'carried'].includes(supplemental.components[component].state)));

  const repeated = initializeRelease({
    version: 'v0.0.9', sourceSha: NEW_SHA, previous: supplemental, selectedComponents: ['helper'],
  });
  assert.deepEqual(repeated, supplemental);
  assert.ok(Object.values(retryPlan(repeated)).every((runnable) => !runnable));
});

test('same-identity auto selection with no source changes remains a no-op', () => {
  const initial = initializeRelease({
    version: 'v0.0.9', sourceSha: NEW_SHA, previous: deliveredPrevious(), selectedComponents: ['server'],
  });
  for (const stage of ['built', 'promoted', 'checked']) markComponentStage(initial, 'server', stage);
  finalizeRelease(initial);
  assert.deepEqual(initializeRelease({
    version: 'v0.0.9', sourceSha: NEW_SHA, previous: initial, selectedComponents: [],
  }), initial);
});

test('selective retry keeps the identity and reruns only an unfinished component', () => {
  const state = initializeRelease({
    version: 'v0.0.9', sourceSha: NEW_SHA, previous: deliveredPrevious(), selectedComponents: ['server', 'helper'],
  });
  for (const stage of ['built', 'promoted', 'checked']) markComponentStage(state, 'server', stage);
  markComponentStage(state, 'helper', 'built');
  assert.deepEqual(retryPlan(state), {
    server: false,
    helper: true,
    'mobile-ota': false,
    'mobile-native': false,
    desktop: false,
    website: false,
  });
  const retry = initializeRelease({
    version: 'v0.0.9', sourceSha: NEW_SHA, retry: state, startedAt: '2026-09-09T13:00:00.000Z',
  });
  assert.equal(retry.components.server.state, 'checked');
  assert.equal(retry.components.helper.state, 'built');
  assert.equal(retry.startedAt, '2026-09-09T13:00:00.000Z');
  assert.throws(
    () => initializeRelease({ version: 'v0.0.10', sourceSha: NEW_SHA, retry: state }),
    /retry identity/,
  );
});

test('retry checkpoints preserve successful build and promotion stages without regression', () => {
  const state = initializeRelease({
    version: 'v0.0.9', sourceSha: NEW_SHA, previous: deliveredPrevious(), selectedComponents: ['server'],
  });
  applyComponentCheckpoints(state, [
    { component: 'server', version: 'v0.0.9', sourceSha: NEW_SHA, state: 'promoted', artifactRef: 'server-ref' },
    { component: 'server', version: 'v0.0.9', sourceSha: NEW_SHA, state: 'built', artifactRef: 'older-ref' },
  ]);
  assert.equal(state.components.server.state, 'promoted');
  assert.equal(state.components.server.artifactRef, 'server-ref');
  assert.equal(retryPlan(state).server, true);
});

test('final manifest refuses absent artifacts and records outcome duration', () => {
  const state = initializeRelease({
    version: 'v0.0.9', sourceSha: NEW_SHA, previous: deliveredPrevious(), selectedComponents: ['server'],
    startedAt: '2026-09-09T12:00:00.000Z',
  });
  assert.throws(() => finalizeRelease(state), /server has no delivered or carried artifact/);
  for (const stage of ['built', 'promoted', 'checked']) markComponentStage(state, 'server', stage);
  finalizeRelease(state, { finishedAt: '2026-09-09T12:03:20.000Z' });
  assert.equal(state.delivery.durationSeconds, 200);
  assert.equal(state.state, 'delivered');
  assert.equal(state.delivery.unproven, undefined);
  state.delivery = undefined;
  finalizeRelease(state, {
    finishedAt: '2026-09-09T12:03:20.000Z',
    unproven: 'mobile OTA promoted with skip_release_proof=true; the emulator release proof did not run',
  });
  assert.equal(state.delivery.unproven, 'mobile OTA promoted with skip_release_proof=true; the emulator release proof did not run');
});

test('release notification timeout is a bounded warning', async () => {
  const result = await notifyRelease({
    version: 'v0.0.9',
    sourceSha: NEW_SHA,
    repository: 'lunchboxfortwo/beeline',
    secret: 'secret',
    timeoutMs: 10,
    fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
      // A real pending request keeps Node alive; AbortSignal.timeout alone does not.
      const pendingRequest = setInterval(() => {}, 1000);
      signal.addEventListener('abort', () => {
        clearInterval(pendingRequest);
        reject(signal.reason);
      }, { once: true });
    }),
  });
  assert.equal(RELEASE_NOTIFY_TIMEOUT_MS, 10_000);
  assert.equal(RELEASE_NOTIFY_ENDPOINT, 'https://server.usebeeline.app/v1/releases/notify');
  assert.deepEqual(result, { state: 'warning', detail: 'timed out after 10ms' });
});

test('release notification non-2xx is a warning', async () => {
  const result = await notifyRelease({
    version: 'v0.0.9', sourceSha: NEW_SHA, repository: 'lunchboxfortwo/beeline', secret: 'secret',
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  assert.deepEqual(result, { state: 'warning', detail: 'server returned HTTP 503' });
});

test('successful release notification is recorded', async () => {
  const result = await notifyRelease({
    version: 'v0.0.9', sourceSha: NEW_SHA, repository: 'lunchboxfortwo/beeline', secret: 'secret',
    fetchImpl: async () => ({ ok: true, status: 204 }),
  });
  assert.deepEqual(result, { state: 'sent', detail: 'server returned HTTP 204' });
});

test('workflow is manual, selective, concurrent, bounded, and component-local on recovery', () => {
  const source = readFileSync(new URL('../.github/workflows/unified-release.yml', import.meta.url), 'utf8');
  const workflow = parse(source);
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  const inputs = workflow.on.workflow_dispatch.inputs;
  // Diagnostics and self-retry inputs are gone; recovery pins and consent stay.
  assert.deepEqual(Object.keys(inputs), [
    'dispatched_by', 'release_sha', 'release_version', 'selection', 'store_track',
    'run_release_proof', 'allow_pin_restore', 'mobile_store_minimum', 'force_listing',
  ]);
  assert.equal(inputs.dispatched_by.required, true);
  assert.equal(inputs.release_sha.required, false);
  assert.equal(inputs.release_version.required, false);
  assert.equal(inputs.selection.default, 'auto');
  assert.equal(inputs.store_track.default, 'none');
  assert.equal(inputs.run_release_proof.default, false);
  assert.equal(inputs.run_release_proof.type, 'boolean');
  for (const name of ['release_sha', 'release_version', 'selection', 'store_track']) {
    assert.match(inputs[name].description, /Recovery only|routine releases keep/, `${name} description`);
  }
  assert.doesNotMatch(source, /plan_only|retry_attempt:\s*\n\s*description|room_open_trace|server_deploy_plan/);
  // Bookkeeping needs no production host tools.
  assert.equal(workflow.jobs.initialize['runs-on'], 'ubuntu-latest');
  assert.equal(workflow.jobs.release_result['runs-on'], 'ubuntu-latest');
  assert.equal(workflow.jobs.initialize['timeout-minutes'], 5);
  assert.equal(workflow.jobs.release_result['timeout-minutes'], 5);
  // Only the legs that build a store binary, run the emulator proof, or build a
  // native helper bundle from cold cargo may exceed the 20-minute job ceiling;
  // every other job stays within it. Job timeouts bound hangs; a release's
  // total duration never fails it.
  const jobCeilingMinutes = 20;
  const slowLegs = new Set(['release_proof', 'mobile_native_android', 'mobile_native_ios', 'helper_macos']);
  for (const [name, job] of Object.entries(workflow.jobs)) {
    const cap = job['timeout-minutes'];
    if (cap === undefined) continue;
    if (slowLegs.has(name)) continue;
    assert.ok(name === 'helper' ? cap <= jobCeilingMinutes : cap < jobCeilingMinutes, `${name} timeout-minutes ${cap} exceeds the job ceiling`);
  }
  assert.doesNotMatch(source, /wait_minutes=35|timeout-minutes:\s*55/);
  assert.match(source, /description: Recovery only - routine releases keep auto/);
  assert.match(source, /version_args=\(release-version --sha "\$release_sha" --reserved-versions/);
  assert.match(source, /version_args\+=\(--previous "\$previous"\)/);
  assert.match(source, /release_sha="\$\{REQUESTED_SHA:-\$GITHUB_SHA\}"/);
  assert.match(source, /git merge-base --is-ancestor "\$release_sha" origin\/main/);
  // The checkout already holds full history; planning fetches nothing again.
  assert.doesNotMatch(workflow.jobs.initialize.steps.find((step) => step.id === 'plan').run, /git fetch/);
  assert.match(source, /unified-release\.mjs component-paths/);
  assert.match(source, /--component-paths "\$RUNNER_TEMP\/release-component-paths\.json"/);
  assert.equal(workflow.jobs.server.if, "needs.initialize.outputs.run_server == 'true'");
  assert.match(source, /needs\.initialize\.outputs\.run_helper == 'true'/);
  assert.match(source, /needs\.initialize\.outputs\.run_mobile_ota == 'true'/);
  // Server and the unchanged-pin OTA both start from the plan alone, so the
  // two production host runners take them side by side.
  assert.equal(workflow.jobs.server.needs, 'initialize');
  assert.equal(workflow.jobs.mobile_ota.needs, 'initialize');
  assert.match(workflow.jobs.mobile_ota.if, /runtime_pin_changed != 'true' && inputs\.run_release_proof != true/);
  assert.deepEqual(workflow.jobs.mobile_ota_after_native.needs, ['initialize', 'mobile_native_android', 'mobile_native_ios', 'release_proof']);
  assert.match(workflow.jobs.mobile_ota_after_native.if, /runtime_pin_changed == 'true' \|\| inputs\.run_release_proof == true/);
  assert.match(workflow.jobs.mobile_ota_after_native.if, /stage_mobile_native == 'checked'/);
  assert.match(workflow.jobs.mobile_ota_after_native.if, /needs\.mobile_native_android\.result == 'success'/);
  assert.match(workflow.jobs.mobile_ota_after_native.if, /needs\.mobile_native_ios\.result == 'success'/);
  for (const [pinChanged, proof, expected] of [
    ['false', false, 'mobile_ota'], ['true', false, 'mobile_ota_after_native'],
    ['false', true, 'mobile_ota_after_native'], ['true', true, 'mobile_ota_after_native'],
  ]) {
    const values = {
      'needs.initialize.result': 'success',
      'needs.initialize.outputs.run_mobile_ota': 'true',
      'needs.initialize.outputs.runtime_pin_changed': pinChanged,
      'needs.initialize.outputs.stage_mobile_native': 'pending',
      'needs.initialize.outputs.native_android': 'true',
      'needs.initialize.outputs.native_ios': 'true',
      'needs.mobile_native_android.result': 'success',
      'needs.mobile_native_ios.result': 'success',
      'inputs.run_release_proof': proof,
    };
    const running = ['mobile_ota', 'mobile_ota_after_native'].filter((job) => githubGate(workflow.jobs[job].if, values));
    assert.deepEqual(running, [expected], `pin changed ${pinChanged}, proof ${proof}`);
  }
  assert.deepEqual(workflow.jobs.release_result.needs, [
    'initialize', 'server', 'helper_macos', 'helper', 'mobile_ota', 'mobile_ota_after_native',
    'mobile_native_android', 'mobile_native_ios', 'desktop_installers', 'website', 'release_proof',
  ]);
  assert.equal(workflow.jobs.desktop_checkpoint, undefined);
  assert.doesNotMatch(source, /needs\.mobile_native\.result/);
  assert.match(source, /needs\.initialize\.outputs\.run_desktop == 'true'/);
  assert.match(source, /needs\.initialize\.outputs\.run_website == 'true'/);
  // One result record: job results become checkpoints in release_result, not
  // a dozen per-stage artifacts.
  assert.doesNotMatch(source, /release-checkpoint-/);
  assert.equal((source.match(/actions\/upload-artifact@v4/g) ?? []).length, 8);
  const result = workflow.jobs.release_result.steps.find((step) => step.id === 'result');
  assert.equal(result.env.NEEDS, '${{ toJSON(needs) }}');
  assert.match(result.run, /unified-release\.mjs job-checkpoints --needs/);
  // A recovery whose earlier attempt already produced the complete merged
  // helper artifact skips the cold Mac cargo builds and reuses it; a fresh
  // identity builds the Mac bundles. The reuse decision is made once in
  // initialize and consumed everywhere else.
  const helperReuse = workflow.jobs.initialize.steps.find((step) => step.id === 'helper_reuse');
  assert.match(helperReuse.uses, /actions\/github-script@v7/);
  assert.equal(helperReuse.if, "steps.plan.outputs.run_helper == 'true'");
  assert.match(workflow.jobs.initialize.outputs.helper_reuse_run_id, /steps\.helper_reuse\.outputs\.run_id/);
  const darwinDownloads = workflow.jobs.helper.steps.filter(
    (step) => step.uses === 'actions/download-artifact@v4' && String(step.with?.name).startsWith('daemon-darwin'),
  );
  assert.equal(darwinDownloads.length, 2);
  // The Mac merge inputs travel only when helper_macos produced them, so
  // daemon-leg's own assertion still names them when they are absent.
  const helperBuild = workflow.jobs.helper.steps.find(
    (step) => step.uses === './.github/actions/daemon-leg' && step.with?.phase === 'build',
  );
  assert.match(helperBuild.with.reuse_run_id, /needs\.initialize\.outputs\.helper_reuse_run_id/);
  for (const key of ['darwin_arm64_bundle_dir', 'darwin_x64_bundle_dir']) {
    assert.match(helperBuild.with[key], /needs\.helper_macos\.result == 'success'/, key);
  }
  const daemonLeg = parse(readFileSync(new URL('../.github/actions/daemon-leg/action.yml', import.meta.url), 'utf8'));
  assert.equal(daemonLeg.inputs.reuse_run_id.default, '');
  assert.equal(daemonLeg.runs.steps.filter((step) => step.id === 'reuse').length, 0);
  const buildSteps = daemonLeg.runs.steps.filter((step) => String(step.if).includes("inputs.phase == 'build'"));
  // Exactly one build step downloads the reused bytes; the fresh-build steps
  // stay off for a reuse, and the caller installs Node, Rust and npm once.
  assert.deepEqual(
    buildSteps.map((step) => {
      if (String(step.if).includes("inputs.reuse_run_id != ''")) return 'reuse';
      if (String(step.if).includes("inputs.reuse_run_id == ''")) return 'build';
      return 'always';
    }),
    ['reuse', 'build', 'build', 'always'],
  );
  assert.ok(!daemonLeg.runs.steps.some((step) => /setup-node|rust-toolchain/.test(String(step.uses))));
  // Promote reads the artifact back from the run that holds it.
  const promoteDownload = daemonLeg.runs.steps.find(
    (step) => step.uses === 'actions/download-artifact@v4' && String(step.if).includes("inputs.phase == 'promote'"),
  );
  assert.match(promoteDownload.with['run-id'], /inputs\.reuse_run_id \|\| github\.run_id/);
  assert.ok(promoteDownload.with['github-token']);
  const helperPromote = workflow.jobs.helper.steps.find(
    (step) => step.uses === './.github/actions/daemon-leg' && step.with?.phase === 'promote',
  );
  assert.match(helperPromote.with.reuse_run_id, /needs\.initialize\.outputs\.helper_reuse_run_id/);
  assert.match(source, /failure_class/);
  assert.match(source, /durationSeconds/);
  assert.doesNotMatch(source, /rolling [0-9]+ release attempts/);
  assert.match(source, /node scripts\/npm-package-visibility\.mjs usebeeline "\$\{RELEASE_VERSION#v\}"/);
  assert.equal(source.match(/npm publish/g)?.length, 1);
});

test('production endpoint, stable downloads, rollback evidence, green gates, and final record remain wired', () => {
  const release = readFileSync(new URL('../.github/workflows/unified-release.yml', import.meta.url), 'utf8');
  const workflow = parse(release);
  const rollback = readFileSync(new URL('../.github/workflows/mobile-ota-rollback.yml', import.meta.url), 'utf8');
  const serverRollback = readFileSync(new URL('../.github/workflows/server-rollback.yml', import.meta.url), 'utf8');
  const serverLeg = readFileSync(new URL('../.github/actions/server-leg/action.yml', import.meta.url), 'utf8');
  const serverLegAction = parse(serverLeg);
  const checks = readFileSync(new URL('../.github/workflows/checks.yml', import.meta.url), 'utf8');
  const desktop = readFileSync(new URL('../.github/workflows/desktop.yml', import.meta.url), 'utf8');
  // The canary readiness check proves each Machine serves this exact
  // release; no second smoke check repeats it.
  assert.doesNotMatch(release, /server-release-smoke/);
  assert.match(release, /BEELINE_REVIEW_SECRET: \$\{\{ secrets\.BEELINE_REVIEW_SECRET \}\}/);
  assert.match(release, /unified-release\.mjs notify/);
  const notification = workflow.jobs.release_result.steps.find((step) => step.id === 'notification');
  assert.equal(notification['continue-on-error'], true);
  const summary = workflow.jobs.release_result.steps.find((step) => step.name?.startsWith('Surface release outcome'));
  assert.match(summary.env.NOTIFICATION_STATE, /no_op == 'true'/);
  for (const name of [
    'Publish immutable attempt state for manual recovery of this identity',
    'Create the one GitHub release record and preserve stable desktop downloads',
    'Notify clients without changing the authoritative release outcome',
    'Finalize successful delivery after every selected promotion and record',
    'Publish the one successful release index',
  ]) {
    const step = workflow.jobs.release_result.steps.find((candidate) => candidate.name === name);
    assert.match(step.if, /no_op != 'true'/);
  }
  assert.match(
    workflow.jobs.release_result.steps.find((step) => step.name === 'Create the one GitHub release record and preserve stable desktop downloads').if,
    /steps\.result\.outputs\.outcome == 'success'/,
  );
  assert.match(summary.env.NOTIFICATION_STATE, /steps\.notification\.outputs\.state/);
  const genuineFailure = workflow.jobs.release_result.steps.find((step) => step.name?.startsWith('Fail the attempt'));
  assert.equal(genuineFailure.if, "steps.result.outputs.outcome != 'success'");
  assert.match(genuineFailure.run, /exit 1/);
  // A failed release never redispatches itself; recovery is an explicit dispatch.
  assert.equal(workflow.jobs.retry, undefined);
  assert.doesNotMatch(release, /createWorkflowDispatch/);
  const resultStep = workflow.jobs.release_result.steps.find((step) => step.name === "Record each component job's result and classify the attempt");
  const otaLeg = parse(readFileSync(new URL('../.github/actions/mobile-ota-leg/action.yml', import.meta.url), 'utf8'));
  const otaLedger = otaLeg.runs.steps.find((step) => step.id === 'ledger');
  assert.match(otaLedger.run, /no rollback ledger/);
  assert.match(otaLedger.run, /completed_at=\$\(date \+%s\)/);
  assert.equal(otaLeg.outputs.completed_at.value, '${{ steps.ledger.outputs.completed_at }}');
  for (const job of ['mobile_ota', 'mobile_ota_after_native']) {
    assert.equal(workflow.jobs[job].outputs.completed_at, '${{ steps.promote.outputs.completed_at }}');
  }
  assert.match(resultStep.run, /unified-release\.mjs classify-attempt/);
  assert.doesNotMatch(resultStep.run, /build-ran|budget/);
  assert.match(resultStep.run, /--checkpoints "\$RUNNER_TEMP\/checkpoints\.json"/);
  assert.doesNotMatch(resultStep.run, /\[ "\$elapsed" -ge "\$budget_seconds" \]/);
  assert.equal(summary.env.SLOW, '${{ steps.result.outputs.slow }}');
  assert.match(summary.run, /Slow: whole run reached/);
  // No termination bookkeeping remains: it only fed the automatic retry.
  assert.doesNotMatch(release, /terminated|server-retry-gates|machinesTouched|reliability/);
  assert.equal(workflow.jobs.release_result.outputs.terminated, undefined);
  const serverLegActionSteps = serverLegAction.runs.steps;
  const migrationIndex = serverLegActionSteps.findIndex((step) => step.name === 'Run schema migrations and backfills once before Machine updates');
  const canaryIndex = serverLegActionSteps.findIndex((step) => step.name === 'Canary one Machine for ninety seconds, then update its peer');
  assert.ok(migrationIndex < canaryIndex);
  assert.doesNotMatch(serverLeg, /machines-touched|migration-failed\.json/);
  assert.match(release, /unified-release-index/);
  assert.match(release, /store_track:/);
  assert.match(rollback, /mobile-ota-rollback-/);
  assert.match(serverRollback, /server-image-ledger-/);
  assert.match(serverRollback, /default: true/);
  assert.match(serverRollback, /flyctl machine update/);
  assert.match(serverLeg, /MIGRATION_DATABASE_URL/);
  const setupNodeIndex = workflow.jobs.server.steps.findIndex((step) => step.uses === 'actions/setup-node@v4');
  const prepareMigrationIndex = workflow.jobs.server.steps.findIndex((step) => step.name === 'Prepare the server migration CLI once');
  const promoteIndex = workflow.jobs.server.steps.findIndex((step) => step.uses === './.github/actions/server-leg');
  assert.ok(setupNodeIndex > 0 && setupNodeIndex < prepareMigrationIndex && prepareMigrationIndex < promoteIndex);
  assert.equal(workflow.jobs.server.steps.filter((step) => step.uses === 'actions/setup-node@v4').length, 1);
  assert.equal(workflow.jobs.server.steps[setupNodeIndex].with['node-version'], 22);
  assert.equal(workflow.jobs.server.steps[setupNodeIndex].with.cache, 'npm');
  const prepareMigration = workflow.jobs.server.steps[prepareMigrationIndex].run;
  assert.match(prepareMigration, /^bash scripts\/npm-ci-timed\.sh$/m);
  assert.doesNotMatch(prepareMigration, /--ignore-scripts|@beeline\/gate/);
  for (const workspace of ['nostr', 'api-contract', 'buzz-client', 'body', 'auth', 'server']) {
    assert.match(prepareMigration, new RegExp(`npm run build -w @beeline/${workspace}`));
  }
  const migrationStep = serverLegAction.runs.steps.find((step) => step.name === 'Run schema migrations and backfills once before Machine updates');
  const migrate = migrationStep.run;
  // Production Postgres is on Neon, reached directly by MIGRATION_DATABASE_URL; no Fly private-network proxy.
  assert.equal(migrationStep.env?.SERVER_DB_DIRECT_IP, undefined);
  assert.match(migrate, /MIGRATION_DATABASE_URL is required/);
  assert.doesNotMatch(migrate, /flyctl proxy/);
  assert.match(migrate, /current_database\(\) AS database/);
  assert.match(migrate, /to_regclass\('public\.messages'\) IS NOT NULL AS has_messages/);
  assert.match(migrate, /database !== 'fly-db' \|\| hasMessages !== true/);
  assert.match(migrate, /MIGRATION_DATABASE_URL does not point at the production database/);
  assert.ok(migrate.indexOf('database !== \'fly-db\'') < migrate.indexOf('npm run migrate -w @beeline/server'));
  assert.match(migrate, /npm run migrate -w @beeline\/server/);
  assert.doesNotMatch(migrate, /npm ci|npm run build/);
  assert.match(serverLeg, /seq 0 6/);
  assert.match(serverLeg, /sleep 15/);
  assert.match(serverLeg, /fly-force-instance-id/);
  assert.match(serverLeg, /server\.usebeeline\.app\/health(?:\s|\\)/);
  assert.doesNotMatch(serverLeg, /server\.usebeeline\.app\/healthz/);
  const promote = serverLegAction.runs.steps.find((step) => step.name === 'Canary one Machine for ninety seconds, then update its peer').run;
  assert.match(release, /SERVER_CANARY_REVIEW_SECRET: \$\{\{ secrets\.SERVER_CANARY_REVIEW_SECRET \}\}/);
  assert.match(release, /SERVER_CANARY_ROOM_ID: \$\{\{ secrets\.SERVER_CANARY_ROOM_ID \}\}/);
  assert.match(promote, /v1\/auth\/review\/exchange/);
  assert.match(promote, /JSON\.stringify\(\{ secret: process\.env\.SERVER_CANARY_REVIEW_SECRET \}\)/);
  assert.match(promote, /::add-mask::\$canary_access_token/);
  assert.match(promote, /::add-mask::\$canary_refresh_token/);
  assert.match(promote, /Authorization: Bearer \$canary_access_token/);
  assert.match(promote, /SERVER_CANARY_REVIEW_SECRET is unset; using the legacy canary phone token/);
  assert.match(promote, /requires SERVER_CANARY_REVIEW_SECRET or SERVER_CANARY_PHONE_TOKEN/);
  assert.ok(promote.indexOf('/v1/auth/review/exchange') < promote.indexOf('for sample in $(seq 0 6)'));
  assert.equal(promote.match(/v1\/auth\/review\/exchange/g)?.length, 1);
  assert.match(promote, /wait_for_machine_ready\(\)/);
  assert.match(promote, /deadline=\$\(\(SECONDS \+ 180\)\)/);
  assert.match(promote, /server\.usebeeline\.app\/readyz/);
  assert.match(promote, /did not become ready within 180s/);
  assert.match(promote, /wait_for_machine_ready "\$canary"/);
  assert.match(promote, /wait_for_machine_ready "\$second"/);
  assert.match(
    promote,
    /retry_flyctl_update "\$canary" "\$image_ref" "canary"\nwait_for_machine_ready "\$canary"/,
  );
  assert.match(
    promote,
    /retry_flyctl_update "\$second" "\$image_ref" "second"\nwait_for_machine_ready "\$second"/,
  );
  assert.ok(promote.indexOf('wait_for_machine_ready "$canary"') < promote.indexOf('/v1/auth/review/exchange'));
  assert.match(promote, /v\.version === process\.argv\[2\] && v\.sourceSha === process\.argv\[3\]/);
  assert.match(promote, /for exchange_attempt in 1 2 3/);
  assert.match(promote, /-H "fly-force-instance-id: \$canary" -H 'Content-Type: application\/json'/);
  assert.match(promote, /5\?\?\) ;;/);
  // Readiness of both Machines already proves the new image; no convergence
  // wait follows success, and one retry covers a transient Fly API failure.
  assert.doesNotMatch(promote, /verify_machine_convergence|Machines not yet converged/);
  assert.equal(promote.match(/flyctl machine update "\$machine"/g)?.length, 2);
  assert.match(promote, /verify_machine_images "\$previous_ref" "\$expected_second"/);
  assert.match(serverLeg, /SERVER_CANARY_PHONE_TOKEN/);
  assert.match(serverLeg, /rollback_canary/);
  assert.match(desktop, /beeline-desktop-release-/);
  for (const gate of ['TYPECHECK', 'BODY SUITE', 'MOBILE SUITE', 'ACTIONLINT']) {
    assert.match(checks, new RegExp(`name: ${gate}$`, 'm'));
  }
});

test('a desktop-carrying retry fetches this release\'s installers, never the previous release\'s', () => {
  const release = readFileSync(new URL('../.github/workflows/unified-release.yml', import.meta.url), 'utf8');
  const workflow = parse(release);
  // Regression: on the v0.0.100-82f1cfb1 retry (runs 34879012393/34879066960)
  // the release-record step read components.desktop.version (= the release
  // being created, because desktop was already checked by an earlier attempt)
  // as the previous version and `gh release download` answered `release not
  // found`. A checked desktop carries THIS release's version, so the retry
  // must fetch the original attempt's artifacts instead.
  const locate = workflow.jobs.release_result.steps.find((step) => step.id === 'desktop_retry_artifacts');
  assert.ok(locate, 'release_result must locate the original attempt\'s desktop installers');
  assert.match(locate.if, /run_desktop != 'true'/);
  assert.match(locate.if, /stage_desktop == 'checked'/);
  assert.match(locate.if, /no_op != 'true'/);
  assert.match(locate.uses, /actions\/github-script@v7/);
  assert.match(locate.with.script, /beeline-desktop-release-/);
  assert.match(locate.with.script, /listArtifactsForRepo/);
  assert.match(locate.with.script, /core\.setFailed/);
  const download = workflow.jobs.release_result.steps.find((step) => step.name === 'Download the desktop installers built by the original attempt');
  assert.ok(download, 'release_result must download the original attempt\'s desktop installers');
  assert.match(download.uses, /actions\/download-artifact@v4/);
  assert.match(download.with['run-id'], /steps\.desktop_retry_artifacts\.outputs\.run_id/);
  assert.ok(download.with['github-token']);
  // Only a CARRIED desktop reads installers from the previous release.
  const record = workflow.jobs.release_result.steps.find((step) => step.name === 'Create the one GitHub release record and preserve stable desktop downloads');
  assert.equal(record.env.STAGE_DESKTOP, "${{ needs.initialize.outputs.stage_desktop }}");
  assert.match(record.run, /\[ "\$RUN_DESKTOP" != true \] && \[ "\$STAGE_DESKTOP" != checked \]/);
  assert.match(record.run, /\[ "\$RUN_DESKTOP" = true \] \|\| \[ "\$STAGE_DESKTOP" = checked \]/);
  // The fresh manifest is built whenever desktop installers belong to this
  // release — a fresh build or a checked retry — and the rollback manifest
  // reads the superseded release in both of those cases.
  const manifest = workflow.jobs.release_result.steps.find((step) => step.name === 'Build the signed desktop update manifest');
  assert.match(manifest.if, /needs\.initialize\.outputs\.run_desktop == 'true' \|\| needs\.initialize\.outputs\.stage_desktop == 'checked'/);
  const preserve = workflow.jobs.release_result.steps.find((step) => step.name === 'Preserve the previous updater manifest for publication rollback');
  assert.match(preserve.run, /\[ "\$RUN_DESKTOP" = true \] \|\| \[ "\$STAGE_DESKTOP" = checked \]/);
  assert.match(preserve.run, /supersedes\?\.version/);
  assert.match(preserve.run, /components\.desktop\.version/);
});

test('canonical routine release guidance is a single no-input dispatch', () => {
  const guide = readFileSync(new URL('../docs/release-pipeline.md', import.meta.url), 'utf8');
  const agents = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');
  assert.match(guide, /calls the first-party `dispatch_release` agent tool with `\{\}`/);
  assert.match(agents, /calls the first-party `dispatch_release` tool/);
  assert.doesNotMatch(agents, /node scripts\/dispatch-production-release\.mjs/);
  assert.match(guide, /Pass no inputs/);
  assert.match(agents, /with no release worker and no inputs/);
});

// GitHub's `if` expressions, evaluated over the operators these gates actually
// use. Anything outside that vocabulary throws rather than quietly reading as
// false, so a rewritten gate cannot pass this by being unrecognised.
function evaluateWorkflowCondition(expression, context) {
  const translated = String(expression)
    .replace(/\s+/g, ' ')
    .replaceAll('cancelled()', 'false')
    .replace(/contains\(fromJSON\('(\[[^']*\])'\), ([^)]+)\)/g, '($1).includes($2)');
  for (const call of translated.matchAll(/([A-Za-z_]\w*)\s*\(/g)) {
    if (call[1] !== 'includes') throw new Error(`unsupported expression function ${call[1]}() in: ${expression}`);
  }
  for (const path of translated.matchAll(/\b(inputs|needs|steps)((?:\.\w+)+)/g)) {
    const value = path[2].slice(1).split('.').reduce((node, key) => node?.[key], context[path[1]]);
    if (value === undefined) throw new Error(`expression reads unset ${path[1]}${path[2]}: ${expression}`);
  }
  return Boolean(new Function('inputs', 'needs', 'steps', `return (${translated});`)(
    context.inputs, context.needs, context.steps,
  ));
}

test('every helper run has either a reused artifact or a Mac rebuild, never neither', () => {
  const workflow = parse(
    readFileSync(new URL('../.github/workflows/unified-release.yml', import.meta.url), 'utf8'),
  );
  const { helper_macos: macos, helper } = workflow.jobs;
  const buildPhase = helper.steps.find(
    (step) => step.uses === './.github/actions/daemon-leg' && step.with?.phase === 'build',
  );
  const promotePhase = helper.steps.find(
    (step) => step.uses === './.github/actions/daemon-leg' && step.with?.phase === 'promote',
  );
  const darwinDownload = helper.steps.find(
    (step) => step.uses === 'actions/download-artifact@v4' && String(step.with?.name).startsWith('daemon-darwin'),
  );
  // Both daemon-leg phases always run; the leg itself picks reuse or build.
  assert.equal(buildPhase.if, undefined);
  assert.equal(promotePhase.if, undefined);

  function resolve({ reuseRunId, macResult }) {
    const initialize = { result: 'success', outputs: { run_helper: 'true', helper_reuse_run_id: reuseRunId } };
    const macosRuns = evaluateWorkflowCondition(macos.if, { inputs: {}, needs: { initialize }, steps: {} });
    const needs = { initialize, helper_macos: { result: macosRuns ? macResult : 'skipped' } };
    const context = { inputs: {}, needs, steps: {} };
    return {
      rebuilds: macosRuns,
      helperRuns: evaluateWorkflowCondition(helper.if, context),
      downloadsMacBundles: evaluateWorkflowCondition(darwinDownload.if, context),
    };
  }

  // A fresh identity produces new Mac artifacts and merges them.
  assert.deepEqual(resolve({ reuseRunId: '', macResult: 'success' }), {
    rebuilds: true, helperRuns: true, downloadsMacBundles: true,
  });
  // A recovery whose merged artifact already exists skips the Mac entirely.
  assert.deepEqual(resolve({ reuseRunId: '4242', macResult: 'success' }), {
    rebuilds: false, helperRuns: true, downloadsMacBundles: false,
  });
  // A failed Mac build never promotes a helper with missing bytes.
  assert.equal(resolve({ reuseRunId: '', macResult: 'failure' }).helperRuns, false);
});

test('fresh Mac bundle carry is optional and every failure selects the cold build', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/unified-release.yml', import.meta.url), 'utf8'));
  const lookup = workflow.jobs.initialize.steps.find(step => step.id === 'previous_mac');
  const steps = workflow.jobs.helper_macos.steps;
  const download = steps.find(step => step.id === 'previous_bundle');
  const carry = steps.find(step => step.id === 'carry_bundle');
  const cold = steps.find(step => step.name === 'Build and install-verify the native helper');
  assert.match(lookup.if, /steps\.helper_reuse\.outputs\.run_id == ''/);
  assert.match(lookup.with.script, /successful\.length !== 1/);
  assert.match(lookup.with.script, /run\.data\.conclusion === 'success'/);
  assert.equal(download['continue-on-error'], true);
  assert.equal(carry['continue-on-error'], true);
  assert.match(carry.run, /--carry-forward/);
  for (const [downloadOutcome, carryOutcome, expectedCold] of [
    ['skipped', 'skipped', true],
    ['failure', 'skipped', true],
    ['success', 'failure', true],
    ['success', 'success', false],
  ]) {
    const context = { inputs: {}, needs: {}, steps: {
      previous_bundle: { outcome: downloadOutcome }, carry_bundle: { outcome: carryOutcome },
    } };
    assert.equal(evaluateWorkflowCondition(carry.if, context), downloadOutcome === 'success');
    assert.equal(evaluateWorkflowCondition(cold.if, context), expectedCold);
  }
  const upload = steps.find(step => step.uses === 'actions/upload-artifact@v4');
  assert.match(upload.with.path, /mac-helper-inputs\.json/);
  // The three-platform merge validates the recovery bootstrap in every input directory.
  assert.match(upload.with.path, /beeline-bootstrap\.mjs\n/);
  assert.match(upload.with.path, /beeline-bootstrap\.mjs\.sha256/);
  assert.equal(lookup['continue-on-error'], true);
  assert.match(workflow.jobs.initialize.outputs.previous_mac_run_id, /steps\.previous_mac\.outputs\.run_id/);
});

test('release_result records a fully delivered slow attempt as a success', () => {
  const workflow = parse(
    readFileSync(new URL('../.github/workflows/unified-release.yml', import.meta.url), 'utf8'),
  );
  const classify = workflow.jobs.release_result.steps.find((step) => step.id === 'result');
  const repoRoot = dirname(dirname(RELEASE_SCRIPT));
  const identity = { version: 'v0.0.9', sourceSha: NEW_SHA };

  // Run the release_result classifier exactly as the job does: a fully
  // delivered attempt whose wall clock passed the old 20-minute budget.
  function classifyDeliveredAttempt(triggerAgoSeconds, { otaResult = 'success' } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'beeline-release-budget-'));
    try {
      const state = initializeRelease(identity);
      const now = Math.floor(Date.now() / 1000);
      const needs = {
        initialize: { result: 'success', outputs: {
          ...Object.fromEntries(RELEASE_COMPONENTS.map((component) => [`run_${component.replace('-', '_')}`, 'true'])),
          native_android: 'true', native_ios: 'true',
        } },
        ...Object.fromEntries(['server', 'helper', 'desktop_installers', 'website',
          'mobile_native_android', 'mobile_native_ios'].map((job) => [job, { result: 'success', outputs: {} }])),
        mobile_ota: { result: otaResult, outputs: { completed_at: String(now - 60) } },
        mobile_ota_after_native: { result: 'skipped', outputs: {} },
      };
      mkdirSync(join(root, 'release'), { recursive: true });
      writeFileSync(join(root, 'release', 'unified-release.json'), JSON.stringify(state));
      const output = join(root, 'github-output');
      writeFileSync(output, '');
      execFileSync('bash', ['-c', classify.run], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          RUNNER_TEMP: root,
          GITHUB_OUTPUT: output,
          TRIGGER_EPOCH: String(now - triggerAgoSeconds),
          NEEDS: JSON.stringify(needs),
          RELEASE_VERSION: identity.version,
          RELEASE_SHA: identity.sourceSha,
          RELEASE_ID: `${identity.version}-${identity.sourceSha}`,
        },
      });
      return Object.fromEntries(
        readFileSync(output, 'utf8').split('\n').filter(Boolean).map((line) => {
          const index = line.indexOf('=');
          return [line.slice(0, index), line.slice(index + 1)];
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // Run 541 shape: every component shipped and the OTA landed 25 minutes
  // after dispatch. The old budget rule failed this release.
  const late = classifyDeliveredAttempt(26 * 60);
  assert.equal(late.outcome, 'success');
  assert.equal(late.failure_class, '');
  assert.equal(late.ota_elapsed_seconds, String(25 * 60));
  assert.equal(late.slow, 'false');
  const slow = classifyDeliveredAttempt(3 * 60 * 60);
  assert.equal(slow.outcome, 'success');
  assert.equal(slow.slow, 'true');
  // A component that did not deliver still fails the release.
  const undelivered = classifyDeliveredAttempt(26 * 60, { otaResult: 'failure' });
  assert.equal(undelivered.outcome, 'failure');
  assert.equal(undelivered.failure_class, 'component:mobile-ota');
});

test('the emulator release proof gates OTA promotion', () => {
  const source = readFileSync(new URL('../.github/workflows/unified-release.yml', import.meta.url), 'utf8');
  const workflow = parse(source);
  const proof = workflow.jobs.release_proof;
  assert.match(proof.if, /run_mobile_ota == 'true'/);
  // A native build that was skipped because it was not needed (carried
  // forward or already checkpointed) no longer suppresses the proof: only a
  // genuinely failed native build stops it. Run 34972989027 skipped the
  // proof exactly because the old clause treated `skipped` as a hold.
  assert.doesNotMatch(proof.if, /native_android != 'true'/);
  assert.match(proof.if, /needs\.mobile_native_android\.result != 'failure'/);
  assert.deepEqual(proof['runs-on'], ['self-hosted', 'beeline-android']);
  const steps = proof.steps;
  const aab = steps.find((step) => step.name === 'Download the native AAB under proof');
  const apk = steps.find((step) => step.name === 'Build the sideload APK under proof (no native build in this run)');
  const run = steps.find((step) => step.name === 'Run the emulator release proof');
  const evidence = steps.find((step) => step.name === 'Preserve release-proof evidence');
  assert.match(aab.if, /needs\.mobile_native_android\.result == 'success'/);
  assert.match(aab.with.name, /mobile-native-android-build-/);
  assert.match(apk.if, /needs\.mobile_native_android\.result != 'success'/);
  // The sideload build IS the carried-build proof path: npm ci installs
  // @beeline/* as unbuilt file: symlinks whose package `main` is dist/index.js
  // (gitignored), so Metro dies in createBundleReleaseJsAndAssets with
  // "this package itself specifies a `main` module field that could not be
  // resolved" and no commit whose Android build was carried can ever be
  // proven (run 35041737312). The step must build the SDK dist exactly the
  // way the native leg's eas-build-post-install does, after npm ci.
  assert.match(apk.run, /npm-ci-timed\.sh/);
  assert.match(apk.run, /npm run eas-build-post-install/);
  assert.ok(
    apk.run.indexOf('npm-ci-timed.sh') < apk.run.indexOf('npm run eas-build-post-install'),
    'eas-build-post-install must run after npm ci',
  );
  // The runner's system node is older than metro-config's use of
  // Array.prototype.toReversed, so the proof job must pin the same node
  // version the native build bundles on.
  const proofNode = steps.find((step) => step.uses === 'actions/setup-node@v4' && step.with?.['node-version']);
  assert.equal(String(proofNode.with['node-version']), '22');
  // The shared rig emulator must survive the OTA-only APK build's teardown.
  assert.equal(apk.env.BEELINE_ANDROID_KEEP_DEVICE, '1');
  assert.match(apk.env.ANDROID_SIDELOAD_KEYSTORE_B64, /secrets\./);
  assert.match(run.run, /release-proof\.mjs --aab "\$RUNNER_TEMP\/proof-binary\/beeline\.aab"/);
  assert.match(run.run, /release-proof\.mjs --apk apps\/mobile\/android\/app\/build\/outputs\/apk\/release\/app-release\.apk/);
  assert.match(evidence.if, /always\(\) && steps\.proof\.conclusion != 'skipped'/);
  assert.match(evidence.with.path, /release-proof-out/);

  // The proof is consent-gated: it runs only when the operator explicitly
  // dispatches with run_release_proof=true. OTA promotion never depends on
  // the proof; when the proof WAS requested and did not succeed, promotion
  // is blocked loudly. Any OTA promoted without a proof is recorded UNPROVEN
  // on the release.
  assert.match(proof.if, /inputs\.run_release_proof == true/);
  const ota = workflow.jobs.mobile_ota_after_native;
  const promote = ota.steps.find((step) => step.uses === './.github/actions/mobile-ota-leg' && step.with.phase === 'promote');
  assert.match(promote.if, /needs\.release_proof\.result == 'success' \|\| inputs\.run_release_proof != true/);
  const refuse = ota.steps.find((step) => step.name === 'Refuse promotion unless the release proof succeeded');
  assert.equal(refuse.if, "inputs.run_release_proof == true && needs.release_proof.result != 'success'");
  assert.match(refuse.run, /exit 1/);
  assert.match(refuse.run, /The proof was explicitly requested for this release, so promotion stays blocked/);
  assert.match(refuse.run, /result: \$\{\{ needs\.release_proof\.result \}\}/);
  // A requested proof always routes the OTA through the job that waits for it.
  assert.match(workflow.jobs.mobile_ota.if, /inputs\.run_release_proof != true/);

  // An unrequested proof records the unproven promotion on the release.
  const result = workflow.jobs.release_result;
  const fin = result.steps.find((step) => step.name === 'Finalize successful delivery after every selected promotion and record');
  assert.match(fin.env.RELEASE_PROOF_UNPROVEN, /needs\.initialize\.outputs\.run_mobile_ota == 'true' && inputs\.run_release_proof != true/);
  assert.match(fin.run, /--unproven/);
  const record = result.steps.find((step) => step.name === 'Create the one GitHub release record and preserve stable desktop downloads');
  assert.match(record.env.RELEASE_PROOF_UNPROVEN, /needs\.initialize\.outputs\.run_mobile_ota == 'true' && inputs\.run_release_proof != true/);
  assert.match(record.run, /Promoted without a device proof/);
});

test('the proof reinstalls over a foreign signature and signs in through the review bypass', () => {
  const proof = readFileSync(
    new URL('../apps/mobile/scripts/release-proof.mjs', import.meta.url),
    'utf8',
  );
  // A rig whose last installed app.usebeeline was signed with a different
  // keystore refuses a clean install with INSTALL_FAILED_UPDATE_INCOMPATIBLE
  // (run 35051048162), so installArtifact must uninstall the existing package
  // before every install attempt, APK and AAB alike.
  const installFn = proof.indexOf('function installArtifact');
  const uninstall = proof.indexOf("adb(device, ['uninstall', APP_ID]");
  const install = proof.indexOf("adb(device, ['install'");
  assert.ok(installFn >= 0, 'installArtifact must exist');
  assert.ok(uninstall > installFn, 'uninstall must run inside installArtifact');
  assert.ok(install > uninstall, 'install must follow the uninstall');
  // The rig session cannot be assumed: a preflight that finds the app signed
  // out fails the whole proof (run 35055087014). The review bypass
  // (BEELINE_REVIEW_SECRET -> beeline://review/<secret>) re-establishes a
  // signed-in session the same way a real sign-in lands.
  assert.match(proof, /BEELINE_REVIEW_SECRET/);
  assert.match(proof, /beeline:\/\/review\//);
});

// Evaluates the subset of GitHub workflow expressions the release gates use:
// && || == !=, parentheses, 'literals', true/false, dotted context paths,
// always(), and contains(fromJSON('…'), path). Missing context resolves to
// null, matching GitHub, and comparisons coerce like GitHub's loose equality.
function githubGate(condition, values) {
  const loose = (a, b) => {
    const norm = (v) => (v === null || v === undefined ? '' : v);
    a = norm(a);
    b = norm(b);
    if ((typeof a === 'boolean' || typeof b === 'boolean') && typeof a !== typeof b) return Number(a) === Number(b);
    return String(a) === String(b);
  };
  const tokens = [];
  const tokenRe = /\s*(==|!=|&&|\|\||\(|\)|,|'[^']*'|[A-Za-z_][A-Za-z0-9_.-]*)/y;
  let index = 0;
  while (index < condition.length) {
    tokenRe.lastIndex = index;
    const match = tokenRe.exec(condition);
    if (!match) throw new Error(`unparsable gate at ${index}: ${condition.slice(index)}`);
    tokens.push(match[1]);
    index = tokenRe.lastIndex;
  }
  let pos = 0;
  const peek = () => tokens[pos];
  const take = () => tokens[pos++];
  const parseOr = () => {
    let left = parseAnd();
    while (peek() === '||') {
      take();
      const right = parseAnd();
      left = Boolean(left) || Boolean(right);
    }
    return left;
  };
  const parseAnd = () => {
    let left = parseCompare();
    while (peek() === '&&') {
      take();
      const right = parseCompare();
      left = Boolean(left) && Boolean(right);
    }
    return left;
  };
  const parseCompare = () => {
    const left = parsePrimary();
    if (peek() === '==' || peek() === '!=') {
      const operator = take();
      const right = parsePrimary();
      return operator === '==' ? loose(left, right) : !loose(left, right);
    }
    return left;
  };
  const parsePrimary = () => {
    if (peek() === '(') {
      take();
      const value = parseOr();
      if (peek() !== ')') throw new Error(`expected ) in ${condition}`);
      take();
      return value;
    }
    const token = take();
    if (token === undefined) throw new Error(`unexpected end of gate: ${condition}`);
    if (token.startsWith("'")) return token.slice(1, -1);
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'always') {
      take();
      take();
      return true;
    }
    if (token === 'contains') {
      take();
      if (take() !== 'fromJSON') throw new Error('contains supports fromJSON lists only');
      take();
      const json = take();
      take();
      if (take() !== ',') throw new Error(`expected , in contains: ${condition}`);
      const needle = parseOr();
      if (peek() !== ')') throw new Error(`expected ) in contains: ${condition}`);
      take();
      return JSON.parse(json.slice(1, -1)).includes(String(needle));
    }
    return values[token] ?? null;
  };
  const result = parseOr();
  if (pos !== tokens.length) throw new Error(`trailing tokens in gate: ${condition}`);
  return result;
}

test('the release proof is consent-gated; a requested proof that fails blocks promotion', () => {
  const workflow = parse(
    readFileSync(new URL('../.github/workflows/unified-release.yml', import.meta.url), 'utf8'),
  );
  const proofIf = workflow.jobs.release_proof.if;
  const ota = workflow.jobs.mobile_ota_after_native;
  const promote = ota.steps.find((step) => step.uses === './.github/actions/mobile-ota-leg' && step.with.phase === 'promote');
  const refuse = ota.steps.find((step) => step.name === 'Refuse promotion unless the release proof succeeded');

  const proofEnv = ({ native_android = 'true', native_result = 'success', run_mobile_ota = 'true', requested = false } = {}) => ({
    'inputs.run_release_proof': requested,
    'needs.initialize.result': 'success',
    'needs.initialize.outputs.run_mobile_ota': run_mobile_ota,
    'needs.initialize.outputs.native_android': native_android,
    'needs.initialize.outputs.native_ios': 'false',
    'needs.initialize.outputs.runtime_pin_changed': 'false',
    'needs.initialize.outputs.stage_mobile_native': 'carried',
    'needs.initialize.outputs.stage_mobile_ota': 'pending',
    'needs.mobile_native_android.result': native_result,
    'needs.mobile_native_ios.result': 'skipped',
    'needs.release_proof.result': 'success',
  });

  // The proof is opt-in: it never runs for a default OTA-only release.
  assert.equal(githubGate(proofIf, proofEnv({})), false, 'the proof is off by default');
  assert.equal(githubGate(proofIf, proofEnv({ requested: true })), true, 'an explicitly requested proof runs');
  // When requested, a carried (skipped) native build must not stop the proof:
  // run 34972989027's exact shape.
  const carried = proofEnv({ native_result: 'skipped', requested: true });
  assert.equal(githubGate(proofIf, carried), true, 'a skipped native build must not stop a requested proof');
  assert.equal(githubGate(ota.if, carried), true, 'mobile_ota runs its build phase for the carried shape');
  assert.equal(
    githubGate(proofIf, proofEnv({ native_android: 'false', native_result: 'skipped', requested: true })),
    true,
    'an OTA-only release has no native build to wait for',
  );
  // Only a native build that genuinely FAILED stops a requested proof.
  assert.equal(githubGate(proofIf, proofEnv({ native_result: 'failure', requested: true })), false);

  // Promotion truth table: OTA promotes whenever the proof was not requested;
  // when it WAS requested, only a successful proof promotes and every other
  // outcome blocks promotion AND fails the job at the refusal step.
  const gateEnv = (proof, requested) => ({
    'needs.initialize.outputs.stage_mobile_ota': 'pending',
    'needs.release_proof.result': proof,
    'inputs.run_release_proof': requested,
  });
  for (const proof of ['success', 'failure', 'skipped', 'cancelled']) {
    assert.equal(githubGate(promote.if, gateEnv(proof, false)), true, `promote(${proof}, not requested)`);
    assert.equal(githubGate(refuse.if, gateEnv(proof, false)), false, `refuse(${proof}, not requested)`);
  }
  assert.equal(githubGate(promote.if, gateEnv('success', true)), true, 'promote(success, requested)');
  assert.equal(githubGate(refuse.if, gateEnv('success', true)), false, 'refuse(success, requested)');
  for (const proof of ['failure', 'skipped', 'cancelled']) {
    assert.equal(githubGate(promote.if, gateEnv(proof, true)), false, `promote(${proof}, requested)`);
    assert.equal(githubGate(refuse.if, gateEnv(proof, true)), true, `refuse(${proof}, requested)`);
  }
});

test('a built-but-never-promoted mobile OTA classifies the attempt as a failed component, not a clean release', () => {
  // With the refusal step failing mobile_ota, only the built checkpoint
  // lands, so release_result's apply-checkpoints must leave mobile-ota
  // incomplete and the attempt classifies `component:mobile-ota` — never a
  // clean success with an unpromoted update.
  const state = initializeRelease({
    version: 'v0.0.9', sourceSha: NEW_SHA, previous: deliveredPrevious(),
    selectedComponents: ['server', 'helper', 'mobile-ota', 'desktop', 'website'],
    startedAt: '2026-09-15T13:07:00.000Z',
  });
  applyComponentCheckpoints(state, [
    { component: 'server', version: 'v0.0.9', sourceSha: NEW_SHA, state: 'checked', artifactRef: 'server-ref' },
    { component: 'helper', version: 'v0.0.9', sourceSha: NEW_SHA, state: 'checked', artifactRef: 'helper-ref' },
    { component: 'mobile-ota', version: 'v0.0.9', sourceSha: NEW_SHA, state: 'built', artifactRef: 'ota-built-ref' },
    { component: 'desktop', version: 'v0.0.9', sourceSha: NEW_SHA, state: 'checked', artifactRef: 'desktop-ref' },
    { component: 'website', version: 'v0.0.9', sourceSha: NEW_SHA, state: 'checked', artifactRef: 'website-ref' },
  ]);
  assert.deepEqual(
    Object.entries(retryPlan(state)).filter(([, runnable]) => runnable).map(([component]) => component),
    ['mobile-ota'],
  );
  assert.throws(
    () => finalizeRelease(state, { outcome: 'success' }),
    /mobile-ota has no delivered or carried artifact/,
  );
});

test('native workflow builds Android locally on the Linux runner and iOS locally on the Mac runner', () => {
  const workflow = parse(
    readFileSync(new URL('../.github/workflows/unified-release.yml', import.meta.url), 'utf8'),
  );
  const android = workflow.jobs.mobile_native_android;
  const ios = workflow.jobs.mobile_native_ios;
  assert.match(android.if, /run_mobile_native == 'true'/);
  assert.match(android.if, /native_android == 'true'/);
  assert.equal(android.needs, 'initialize');
  assert.deepEqual(android['runs-on'], ['self-hosted', 'beeline-android']);
  assert.equal(android['timeout-minutes'], 60);
  assert.match(ios.if, /run_mobile_native == 'true'/);
  assert.match(ios.if, /native_ios == 'true'/);
  assert.equal(ios.needs, 'initialize');
  assert.deepEqual(ios['runs-on'], ['self-hosted', 'macOS', 'X64', 'ios-builder']);
  assert.equal(ios['timeout-minutes'], 90);
  for (const job of [android, ios]) {
    const setups = job.steps.filter((step) => step.uses === 'actions/setup-node@v4');
    assert.equal(setups.length, 1);
    assert.equal(setups[0].with['node-version'], 22);
    assert.ok(job.steps.some((step) => step.uses === './.github/actions/eas-cli'));
    assert.equal(job.env?.EAS_CLI_VERSION, undefined);
  }

  const androidSteps = android.steps;
  const androidBuild = androidSteps.find((step) => step.name === 'Build immutable Android store binary locally');
  const credentials = androidSteps.find((step) => step.name === 'Require native release credentials');
  const project = mkdtempSync(join(tmpdir(), 'beeline-native-platforms-'));
  try {
    const env = { ...process.env, RUNNER_TEMP: project, EAS_CLI_VERSION: 'test', EXPO_TOKEN: 'fixture' };
    execFileSync('bash', ['-euc', credentials.run], { env });
    // The Android leg builds on the self-hosted Linux runner (PR #1229) with
    // the one locked eas-cli and writes the aab straight into RUNNER_TEMP.
    assert.match(androidBuild.run, /for candidate in "\$\{ANDROID_HOME:-\}" \/home\/lunchbox\/android-sdk "\$HOME\/Android\/Sdk"/);
    assert.match(androidBuild.run, /test -d "\$\{ANDROID_HOME:-\}\/platform-tools"/);
    assert.match(
      androidBuild.run,
      /"\$EAS_CLI_PATH" build --local --platform android --profile production-ci --non-interactive --output "\$RUNNER_TEMP\/beeline\.aab"/,
    );
    assert.doesNotMatch(androidBuild.run, /npx/);
    assert.match(androidBuild.run, /test -s "\$RUNNER_TEMP\/beeline\.aab"/);
    for (const step of androidSteps.filter((step) =>
      ['Authenticate to Google Play', 'Upload Android to the selected Play track'].includes(step.name)
    )) {
      assert.match(step.if, /store_track != 'none'/);
    }
    const playUpload = androidSteps.find((step) => step.name === 'Upload Android to the selected Play track');
    assert.equal(playUpload.env.PACKAGE_NAME, 'app.usebeeline');

    const iosCredentials = ios.steps.find((step) => step.name === 'Require iOS release credentials');
    const iosBuild = ios.steps.find((step) => step.name === 'Build immutable iOS store binary locally');
    const iosSubmit = ios.steps.find((step) => step.name?.startsWith('Submit iOS'));
    const isolateKeychain = ios.steps.find((step) => step.name === 'Isolate the iOS signing keychain');
    const cleanup = ios.steps.find((step) => step.name === 'Remove iOS credentials and build output');
    const restoreKeychains = ios.steps.find((step) => step.name === 'Restore the runner user keychains');
    assert.match(isolateKeychain.run, /security list-keychains -d user > "\$RUNNER_TEMP\/user-keychains\.txt"/);
    assert.match(isolateKeychain.run, /security default-keychain -d user > "\$RUNNER_TEMP\/user-default-keychain\.txt"/);
    assert.match(isolateKeychain.run, /security list-keychains -d user -s ~\/Library\/Keychains\/login\.keychain-db/);
    assert.ok(ios.steps.indexOf(isolateKeychain) < ios.steps.indexOf(iosBuild));
    for (const step of [iosCredentials, iosBuild, iosSubmit]) {
      assert.match(step.run, /# Keep Apple's openrsync ahead of Homebrew rsync during Xcode IPA export\./);
      assert.ok(step.run.includes('PATH="$(dirname "$(command -v node)"):/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin"'));
    }
    assert.match(iosCredentials.run, /EXPO_APPLE_TEAM_ID=89KT3SWYAF/);
    assert.match(iosCredentials.run, /EXPO_NO_CAPABILITY_SYNC=1/);
    assert.match(iosCredentials.run, /EAS_SKIP_AUTO_FINGERPRINT=1/);
    assert.match(iosBuild.run, /"\$EAS_CLI_PATH" build --local --platform ios --profile production-ci --non-interactive --output/);
    assert.doesNotMatch(iosBuild.run, /npx/);
    assert.match(iosBuild.run, /test -s "\$RUNNER_TEMP\/beeline-ios\.ipa"/);
    assert.match(iosBuild.run, /python3 ..\/..\/scripts\/ios-build-evidence\.py "\$RUNNER_TEMP\/beeline-ios\.ipa" "\$RUNNER_TEMP\/ios-build\.json"/);
    assert.match(iosSubmit.run, /ios-store-build\.mjs prepare "\$RUNNER_TEMP\/ios-build\.json"/);
    assert.match(iosSubmit.run, /ios-store-build\.mjs verify "\$RUNNER_TEMP\/ios-build\.json" "\$RUNNER_TEMP\/ios-upload\.json"/);
    assert.ok(iosSubmit.run.indexOf('ios-store-build.mjs prepare') < iosSubmit.run.indexOf('xcrun altool --upload-app'));
    assert.ok(iosSubmit.run.indexOf('ios-store-build.mjs verify') > iosSubmit.run.indexOf('xcrun altool --upload-app'));
    assert.match(
      iosSubmit.run,
      /xcrun altool --upload-app -t ios -f "\$RUNNER_TEMP\/beeline-ios\.ipa" \\\n\s+--apiKey "\$EXPO_ASC_KEY_ID" --apiIssuer "\$EXPO_ASC_ISSUER_ID" --output-format json/,
    );
    assert.doesNotMatch(iosSubmit.run, /npx .*eas submit/);
    assert.match(cleanup.run, /rm -rf "\$RUNNER_TEMP\/private_keys"/);
    const appReview = ios.steps.find((step) => step.name === 'Send production iOS version to App Review');
    assert.equal(appReview.if, "inputs.store_track == 'production'");
    assert.match(appReview.run, /ios-store-build\.mjs submit/);
    assert.ok(ios.steps.indexOf(appReview) > ios.steps.indexOf(iosSubmit));
    assert.ok(ios.steps.indexOf(appReview) < ios.steps.findIndex((step) => step.name === 'Preserve iOS build evidence'));
    const androidEvidence = androidSteps.find((step) => step.name === 'Preserve Android build evidence');
    const iosEvidence = ios.steps.find((step) => step.name === 'Preserve iOS build evidence');
    assert.equal(androidEvidence.with.name, 'mobile-native-android-build-${{ needs.initialize.outputs.release_id }}');
    assert.match(androidEvidence.with.path, /android-build\.json[\s\S]*beeline\.aab/);
    assert.equal(iosEvidence.with.name, 'mobile-native-ios-build-${{ needs.initialize.outputs.release_id }}');
    assert.equal(iosEvidence.with.path, '${{ runner.temp }}/ios-build.json');

    assert.equal(cleanup.if, 'always()');
    assert.match(cleanup.run, /rm -f .*AuthKey_.*beeline-ios\.ipa/);
    assert.equal(restoreKeychains.if, 'always()');
    assert.ok(ios.steps.indexOf(restoreKeychains) > ios.steps.indexOf(cleanup));
    assert.match(restoreKeychains.run, /xargs security list-keychains -d user -s < "\$RUNNER_TEMP\/user-keychains\.txt"/);
    assert.match(restoreKeychains.run, /xargs security default-keychain -d user -s < "\$RUNNER_TEMP\/user-default-keychain\.txt"/);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test('ios-review-node: App Review establishes the runner Node PATH before submission', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/unified-release.yml', import.meta.url), 'utf8'));
  const ios = workflow.jobs.mobile_native_ios;
  const review = ios.steps.find((step) => step.name === 'Send production iOS version to App Review');
  const nodePath = '/usr/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin';
  assert.equal(review.if, "inputs.store_track == 'production'");
  assert.equal(review['working-directory'], undefined);
  assert.equal(ios.defaults?.run?.['working-directory'], undefined);
  assert.ok(review.run.includes('PATH="$(dirname "$(command -v node)"):/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin"'));
  assert.match(review.run, /export PATH\n[\s\S]*node scripts\/ios-store-build\.mjs submit/);

  // Stand in for the Mac's Node binary without calling Apple or changing the host.
  const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-euc', `
    command() { if [[ "$1" = -v && "$2" = node ]]; then printf '/usr/bin/node'; else builtin command "$@"; fi; }
    node() {
      if [[ "$PATH" != '${nodePath}' ]]; then
        echo 'node: command not found' >&2
        return 127
      fi
      printf '%s\\n' "$@"
    }
    ${review.run}
  `], { env: { PATH: '/usr/bin:/bin', RUNNER_TEMP: '/tmp/ios-review-node' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'scripts/ios-store-build.mjs\nsubmit\n/tmp/ios-review-node/ios-build.json\n');
});

test('helper job accommodates the npm visibility deadline plus publication overhead', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/unified-release.yml', import.meta.url), 'utf8'));
  const budgetMs = workflow.jobs.helper['timeout-minutes'] * 60_000;
  assert.ok(budgetMs >= NPM_VISIBILITY_TIMEOUT_MS + 5 * 60_000, 'helper job must allow the default npm visibility deadline plus five minutes for setup and publication');
});


test('release-manual-recovery: the dispatch initializer resumes a failed identity', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/unified-release.yml', import.meta.url), 'utf8'));
  const plan = workflow.jobs.initialize.steps.find((step) => step.id === 'plan');
  const dir = mkdtempSync(join(tmpdir(), 'manual-release-retry-'));
  try {
    mkdirSync(join(dir, 'retry'));
    const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    // Keep git reads and the release planner real. Only remote operations are mocked.
    const shell = `git() {
      if [ "$1" = fetch ] || [ "$1" = merge-base ]; then return 0; fi
      command git "$@"
    }
    ghr_requested_version_guard() { return 0; }
    `;
    // The sourced helper defines the guard, so install its stub after sourcing.
    const run = plan.run.replace('. scripts/gh-release-retry.sh', '. scripts/gh-release-retry.sh\n' + shell);
    {
      const retry = initializeRelease({ version: 'v0.0.9', sourceSha });
      retry.delivery = { state: 'failure', failureClass: 'component:server' };
      writeFileSync(join(dir, 'retry/release-attempt.json'), JSON.stringify(retry));
      const result = spawnSync('bash', ['-euc', run], { encoding: 'utf8', env: {
        ...process.env, RUNNER_TEMP: dir, PLAN_ONLY: 'false', REQUESTED_SHA: sourceSha,
        REQUESTED_VERSION: 'v0.0.9', SELECTION: 'all', STORE_TRACK: 'none',
        GITHUB_OUTPUT: join(dir, 'outputs'), GITHUB_STEP_SUMMARY: join(dir, 'summary'),
      } });
      assert.equal(result.status, 0, result.stderr);
      const summary = JSON.parse(readFileSync(join(dir, 'release-plan.json'), 'utf8'));
      assert.equal(summary.identity, `v0.0.9@${sourceSha}`);
      assert.ok(Object.values(summary.retry).every(Boolean));
      assert.match(readFileSync(join(dir, 'outputs'), 'utf8'), /run_server=true/);
      // Never promoted: the OTA recovers as a first attempt.
      assert.match(readFileSync(join(dir, 'outputs'), 'utf8'), /^stage_mobile_ota=pending$/m);
    }
    {
      // Promotion started before the attempt failed: the OTA leg recovers
      // only that exact promotion.
      const retry = initializeRelease({ version: 'v0.0.9', sourceSha });
      applyComponentCheckpoints(retry, [{ component: 'mobile-ota', version: 'v0.0.9', sourceSha, state: 'promoted', artifactRef: 'ota' }]);
      writeFileSync(join(dir, 'retry/release-attempt.json'), JSON.stringify(retry));
      writeFileSync(join(dir, 'outputs'), '');
      const result = spawnSync('bash', ['-euc', run], { encoding: 'utf8', env: {
        ...process.env, RUNNER_TEMP: dir, REQUESTED_SHA: sourceSha,
        REQUESTED_VERSION: 'v0.0.9', SELECTION: 'all', STORE_TRACK: 'none',
        GITHUB_OUTPUT: join(dir, 'outputs'), GITHUB_STEP_SUMMARY: join(dir, 'summary'),
      } });
      assert.equal(result.status, 0, result.stderr);
      const outputs = readFileSync(join(dir, 'outputs'), 'utf8');
      assert.match(outputs, /^stage_mobile_ota=promoted$/m);
      assert.match(outputs, /^run_mobile_ota=true$/m);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('both native builds apply the one resolved store version before EAS, with no extra jobs or inputs', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/unified-release.yml', import.meta.url), 'utf8'));
  const resolve = workflow.jobs.initialize.steps.find((step) => step.id === 'native_version');
  assert.equal(resolve.if, "steps.plan.outputs.run_mobile_native == 'true'");
  assert.match(resolve.run, /git show "\$RELEASE_SHA:apps\/mobile\/package.json"/);
  assert.match(resolve.run, /STORE_TRACK.*production/);
  assert.match(resolve.run, /ios-store-build.mjs resolve-version/);
  assert.equal(resolve.env.EXPO_ASC_API_KEY_P8, '${{ secrets.EXPO_ASC_API_KEY_P8 }}');
  assert.equal(workflow.jobs.initialize.outputs.native_app_version, '${{ steps.native_version.outputs.version }}');
  const dir = mkdtempSync(join(tmpdir(), 'native-resolved-version-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts/check-release-version.cjs'), 'console.log("0.2.22")');
    for (const name of ['mobile_native_android', 'mobile_native_ios']) {
      const job = workflow.jobs[name];
      const apply = job.steps.find((step) => step.name === 'Apply the resolved native store version');
      const build = job.steps.find((step) => step.name?.startsWith('Build immutable'));
      assert.equal(job.needs, 'initialize');
      assert.ok(job.steps.indexOf(apply) < job.steps.indexOf(build));
      assert.equal(apply.env.NATIVE_APP_VERSION, '${{ needs.initialize.outputs.native_app_version }}');
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.2.22' }));
      execFileSync('bash', ['-euc', 'node() { "$TEST_NODE_BINARY" "$@"; }\n' + apply.run], { cwd: dir,
        env: { ...process.env, TEST_NODE_BINARY: process.execPath, NATIVE_APP_VERSION: '0.2.23' } });
      assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'))).version, '0.2.23');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Reproduction release-dispatch-serialization: production-free stand-in.
test('release-dispatch-serialization: a second production release cannot cancel the running release', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/unified-release.yml', import.meta.url), 'utf8'));
  assert.equal(workflow.concurrency.group, 'unified-production-release');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
});

test('release-dispatch-attribution: operator command refuses an unauthenticated turn', () => {
  const script = fileURLToPath(new URL('./dispatch-production-release.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8', env: { ...process.env, BEELINE_DAEMON_TOKEN: '' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires an authenticated Beeline agent turn/);
});

test('release-dispatch-attribution: workflow refuses missing provenance', async () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/unified-release.yml', import.meta.url), 'utf8'));
  assert.equal(workflow.on.workflow_dispatch.inputs.dispatched_by.required, true);
  assert.match(workflow['run-name'], /inputs.dispatched_by/);
  const attribution = workflow.jobs.initialize.steps.find(step => step.name === 'Verify release dispatch attribution');
  const execute = new (Object.getPrototypeOf(async function () {}).constructor)('core', attribution.with.script);
  const previous = process.env.DISPATCHED_BY;
  const summary = { addHeading() { return this; }, addCodeBlock() { return this; }, async write() {} };
  try {
    process.env.DISPATCHED_BY = '{}';
    await assert.rejects(execute({ summary }), /requires dispatch attribution: agentId/);
    process.env.DISPATCHED_BY = JSON.stringify({ agentId: 'agent', handle: 'jellybean', place: 'room', humanCommandMessageId: 'human', auditMessageId: 'audit' });
    await execute({ summary });
  } finally {
    if (previous === undefined) delete process.env.DISPATCHED_BY;
    else process.env.DISPATCHED_BY = previous;
  }
});

test('missing-sourcemap: web hosting waits for private map upload before deployment', () => {
  const action = parse(readFileSync('.github/actions/web-app-leg/action.yml', 'utf8'));
  const steps = action.runs.steps;
  const exportIndex = steps.findIndex(step => step.run?.includes('expo export'));
  const uploadIndex = steps.findIndex(step => step.run?.includes('prepare-web-sourcemaps.mjs'));
  const deployIndex = steps.findIndex(step => step.run?.includes('deploy --prod'));
  assert.match(steps[exportIndex].run, /--source-maps/);
  assert.ok(exportIndex < uploadIndex && uploadIndex < deployIndex);
  assert.equal(steps[uploadIndex]['continue-on-error'], undefined);
  assert.equal(steps[uploadIndex].env.SENTRY_AUTH_TOKEN, '${{ inputs.sentry_auth_token }}');
  assert.equal(steps[exportIndex].env.SENTRY_AUTH_TOKEN, undefined);
  const workflow = parse(readFileSync('.github/workflows/unified-release.yml', 'utf8'));
  const web = workflow.jobs.website.steps.find(step => step.uses === './.github/actions/web-app-leg');
  assert.equal(web.with.sentry_auth_token, '${{ secrets.SENTRY_AUTH_TOKEN }}');
  assert.deepEqual(COMPONENT_PATH_RULES.find(rule => rule.exact === 'apps/mobile/scripts/prepare-web-sourcemaps.mjs').components, ['website']);
});
