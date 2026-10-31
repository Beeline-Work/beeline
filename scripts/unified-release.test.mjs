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
  pendingComponents,
  applyJobFacts,
  planOutputs,
  otaMemory,
  selectReleaseComponents,
  selectReleaseComponentsFromPublishedInputs,
} from './unified-release.mjs';

import { encodeReleaseOutput, decodeReleaseOutput } from './release-job-output.mjs';

const OLD_SHA = '1'.repeat(40);
const MID_SHA = '3'.repeat(40);
const NEW_SHA = '2'.repeat(40);
const RELEASE_SCRIPT = fileURLToPath(new URL('./unified-release.mjs', import.meta.url));

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
    mobile_ota_after_proof: { result: 'success', outputs: { completed_at: '1700000600' } },
    mobile_native_android: { result: 'success', outputs: {} },
    mobile_native_ios: { result: 'skipped', outputs: {} },
    desktop_installers: { result: 'failure', outputs: {} },
    website: { result: 'success', outputs: {} },
    ...overrides,
  });
  assert.deepEqual(checkpointsFromJobs(needs(), identity), [
    { component: 'server', version: 'v0.0.9', sourceSha: NEW_SHA, state: 'checked', artifactRef: `server-artifact-v0.0.9-${NEW_SHA}` },
    { component: 'mobile-ota', version: 'v0.0.9', sourceSha: NEW_SHA, state: 'checked',
      artifactRef: `mobile-ota-release-v0.0.9-${NEW_SHA}`, completedAt: 1_700_000_600 },
    { component: 'website', version: 'v0.0.9', sourceSha: NEW_SHA, state: 'checked', artifactRef: `website-v0.0.9-${NEW_SHA}` },
    { component: 'mobile-native', version: 'v0.0.9', sourceSha: NEW_SHA, state: 'checked', artifactRef: `mobile-native-v0.0.9-${NEW_SHA}` },
  ]);
  // A failed OTA job leaves the OTA pending; a rerun asks EAS what shipped.
  assert.ok(!checkpointsFromJobs(needs({
    mobile_ota_after_proof: { result: 'failure', outputs: {} },
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
  assert.deepEqual(Object.entries(pendingComponents(state)).filter(([, open]) => open).map(([component]) => component), ['desktop']);
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

test('routine same-head release supplements lagging shared UI consumers and reruns in place', () => {
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
  const version = previous.version;
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

  // A rerun plans the same legs again; each leg asks its system what shipped.
  const rerun = initializeRelease({ version, sourceSha: NEW_SHA, previous, selectedComponents: selected });
  assert.deepEqual(pendingComponents(rerun), pendingComponents(state));

  for (const component of selected) for (const stage of ['built', 'promoted', 'checked']) markComponentStage(rerun, component, stage);
  finalizeRelease(rerun);
  const noChanges = Object.fromEntries(RELEASE_COMPONENTS.map((component) => [component, []]));
  const noOp = initializeRelease({
    version: rerun.version,
    sourceSha: NEW_SHA,
    previous: rerun,
    selectedComponents: selectReleaseComponentsFromPublishedInputs(noChanges),
  });
  assert.deepEqual(noOp, rerun);
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
    // A pin change is not a store consent: it neither fails nor adds a store leg.
    assert.ok(!select({ runtimePin: { changed: true, previous: '23', next: '24' } }).includes('mobile-native'));
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

// Reproduction PIN-STORE-NONE (runs 40980492449, 40803542083, 40686644708,
// 40027907679, 39312903562): a merge bumped the phone runtime pin and a
// routine release (store_track none) failed in planning with
// "runtime pin changed ... --store-track must name the store submission track".
test('PIN-STORE-NONE: a runtime-pin change with store_track none plans an OTA release and no store leg', () => {
  const changed = { changed: true, changedPlatforms: ['android'], previous: { android: '40', ios: '36' }, next: { android: '43', ios: '36' } };
  for (const select of [
    () => selectReleaseComponents(['apps/mobile/native-fingerprint.json', 'apps/mobile/sources/index.ts'], {
      selection: 'auto', storeTrack: 'none', runtimePin: changed,
    }),
    () => selectReleaseComponentsFromPublishedInputs(Object.fromEntries(RELEASE_COMPONENTS.map((component) =>
      [component, ['apps/mobile/native-fingerprint.json', 'apps/mobile/sources/index.ts']])), {
      selection: 'auto', storeTrack: 'none', runtimePin: changed,
    }),
  ]) {
    const selected = select();
    assert.ok(selected.includes('mobile-ota'));
    assert.ok(!selected.includes('mobile-native'));
  }
  // Explicit selections without mobile-native no longer fail either.
  assert.deepEqual(selectReleaseComponents([], { selection: 'mobile-ota', storeTrack: 'none', runtimePin: changed }), ['mobile-ota']);
  // Store publishing stays explicit consent: only --store-track adds it.
  assert.deepEqual(selectReleaseComponents([], { storeTrack: 'internal', runtimePin: changed }), ['mobile-native']);
});

test('PIN-STORE-NONE: the plan CLI returns a plan, a notice and no store leg for a pin change', () => {
  const root = mkdtempSync(join(tmpdir(), 'beeline-pin-test-'));
  try {
    run('git', ['init', '--quiet'], root);
    run('git', ['config', 'user.email', 'release-test@usebeeline.app'], root);
    run('git', ['config', 'user.name', 'Release Test'], root);
    const pin = (android) => JSON.stringify({ android: { runtimeVersion: android }, ios: { runtimeVersion: '36' } });
    writeFixture(root, 'apps/mobile/native-fingerprint.json', `${pin('40')}\n`);
    run('git', ['add', '.'], root);
    run('git', ['commit', '--quiet', '-m', 'store pins'], root);
    const oldSha = run('git', ['rev-parse', 'HEAD'], root).trim();
    writeFixture(root, 'apps/mobile/native-fingerprint.json', `${pin('43')}\n`);
    writeFixture(root, 'apps/mobile/sources/index.ts', 'export const fix = true;\n');
    run('git', ['add', '.'], root);
    run('git', ['commit', '--quiet', '-m', 'bump android runtime'], root);
    const releaseSha = run('git', ['rev-parse', 'HEAD'], root).trim();
    const previous = deliveredPrevious();
    previous.sourceSha = oldSha;
    for (const component of RELEASE_COMPONENTS) previous.components[component].sourceSha = oldSha;
    previous.components['mobile-ota'].otaBranch = 'release-v0.0.8';
    previous.components['mobile-ota'].otaTargets = ['android@40', 'android@39', 'android@38', 'ios@36', 'ios@34', 'ios@31'];
    const previousPath = join(root, 'previous.json');
    writeFileSync(previousPath, `${JSON.stringify(previous)}\n`);
    run('node', [RELEASE_SCRIPT, 'component-paths', '--previous', previousPath, '--sha', releaseSha,
      '--output', join(root, 'component-paths.json'), '--paths-output', join(root, 'paths.txt')], root);
    const outputs = join(root, 'outputs.txt');
    const stdout = run('node', [
      RELEASE_SCRIPT, 'plan', '--version', 'v0.0.9', '--sha', releaseSha, '--previous', previousPath,
      '--paths', join(root, 'paths.txt'), '--component-paths', join(root, 'component-paths.json'),
      '--selection', 'auto', '--store-track', 'none', '--state', join(root, 'state.json'),
      '--summary', join(root, 'summary.json'), '--outputs', outputs,
    ], root);
    assert.match(stdout, /Runtime pin changed without a store release::android 40 -> 43/);
    const lines = Object.fromEntries(readFileSync(outputs, 'utf8').trim().split('\n').map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index), line.slice(index + 1)];
    }));
    assert.equal(lines.run_mobile_ota, 'true');
    assert.equal(lines.run_mobile_native, 'false');
    assert.equal(lines.runtime_pin_changed, 'true');
    // The OTA leg is handed the runtimes the previous release served.
    assert.deepEqual(decodeReleaseOutput(lines.ota_memory).previousTargets.map((t) => `${t.platform}@${t.runtimeVersion}`),
      ['android@40', 'android@39', 'android@38', 'ios@36', 'ios@34', 'ios@31']);
    assert.equal(decodeReleaseOutput(lines.ota_memory).previousBranch, 'release-v0.0.8');
    assert.equal(decodeReleaseOutput(lines.release_state).plan.paths, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
    assert.deepEqual(selectReleaseComponents([], { runtimePin: pins }), []);
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
  assert.deepEqual(pendingComponents(supplemental), {
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
  assert.ok(Object.values(pendingComponents(repeated)).every((runnable) => !runnable));
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

test('checkpoints preserve successful build and promotion stages without regression', () => {
  const state = initializeRelease({
    version: 'v0.0.9', sourceSha: NEW_SHA, previous: deliveredPrevious(), selectedComponents: ['server'],
  });
  applyComponentCheckpoints(state, [
    { component: 'server', version: 'v0.0.9', sourceSha: NEW_SHA, state: 'promoted', artifactRef: 'server-ref' },
    { component: 'server', version: 'v0.0.9', sourceSha: NEW_SHA, state: 'built', artifactRef: 'older-ref' },
  ]);
  assert.equal(state.components.server.state, 'promoted');
  assert.equal(state.components.server.artifactRef, 'server-ref');
  assert.equal(pendingComponents(state).server, true);
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
    'run_release_proof', 'allow_pin_restore', 'mobile_store_minimum', 'publish_listing',
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
  // Identity comes from GitHub Releases: the previous record and any draft at
  // this commit. Nothing is read from an earlier run.
  const identity = workflow.jobs.initialize.steps.find((step) => step.id === 'identity');
  assert.match(identity.run, /release-record\.mjs identity --sha "\$release_sha" --requested "\$REQUESTED_VERSION"/);
  assert.match(identity.run, /ghr_create "\$version" --target "\$release_sha" .*--draft/);
  assert.match(identity.run, /release_sha=\$\(git rev-parse --verify "\$\{REQUESTED_SHA:-\$GITHUB_SHA\}\^\{commit\}"\)/);
  assert.match(source, /git merge-base --is-ancestor "\$release_sha" origin\/main/);
  // The checkout already holds full history; planning fetches nothing again.
  assert.doesNotMatch(workflow.jobs.initialize.steps.find((step) => step.id === 'plan').run, /git fetch/);
  assert.match(source, /unified-release\.mjs component-paths/);
  assert.match(source, /--component-paths "\$RUNNER_TEMP\/release-component-paths\.json"/);
  assert.equal(workflow.jobs.server.if, "needs.initialize.outputs.run_server == 'true'");
  assert.match(source, /needs\.initialize\.outputs\.run_helper == 'true'/);
  assert.match(source, /needs\.initialize\.outputs\.run_mobile_ota == 'true'/);
  // Server and the OTA both start from the plan alone, so the two production
  // host runners take them side by side. The OTA never waits for a store
  // binary; only a requested device proof holds it.
  assert.equal(workflow.jobs.server.needs, 'initialize');
  assert.equal(workflow.jobs.mobile_ota.needs, 'initialize');
  assert.deepEqual(workflow.jobs.mobile_ota_after_proof.needs, ['initialize', 'release_proof']);
  for (const [pinChanged, proof, expected] of [
    ['false', false, 'mobile_ota'], ['true', false, 'mobile_ota'],
    ['false', true, 'mobile_ota_after_proof'], ['true', true, 'mobile_ota_after_proof'],
  ]) {
    const values = {
      'needs.initialize.result': 'success',
      'needs.initialize.outputs.run_mobile_ota': 'true',
      'needs.initialize.outputs.runtime_pin_changed': pinChanged,
      'inputs.run_release_proof': proof,
    };
    const running = ['mobile_ota', 'mobile_ota_after_proof'].filter((job) => githubGate(workflow.jobs[job].if, values));
    assert.deepEqual(running, [expected], `pin changed ${pinChanged}, proof ${proof}`);
  }
  assert.deepEqual(workflow.jobs.release_result.needs, [
    'initialize', 'server', 'helper_macos', 'helper', 'mobile_ota', 'mobile_ota_after_proof',
    'mobile_native_android', 'mobile_native_ios', 'desktop_installers', 'website', 'release_proof',
  ]);
  assert.equal(workflow.jobs.desktop_checkpoint, undefined);
  assert.doesNotMatch(source, /needs\.mobile_native\.result/);
  assert.match(source, /needs\.initialize\.outputs\.run_desktop == 'true'/);
  assert.match(source, /needs\.initialize\.outputs\.run_website == 'true'/);
  // One result record: job results become checkpoints in release_result, and
  // jobs hand facts over through job outputs, never through artifacts.
  assert.doesNotMatch(source, /release-checkpoint-|unified-release-index|unified-release-state|unified-release-plan|server-image-ledger|store-runtime-|run-id:/);
  const result = workflow.jobs.release_result.steps.find((step) => step.id === 'result');
  assert.equal(result.env.NEEDS, '${{ toJSON(needs) }}');
  assert.equal(result.env.RELEASE_STATE, '${{ needs.initialize.outputs.release_state }}');
  assert.match(result.run, /unified-release\.mjs job-checkpoints --needs/);
  assert.match(result.run, /apply-facts --state/);
  // The Mac bundles travel only inside this run; the helper leg merges them.
  const darwinDownloads = workflow.jobs.helper.steps.filter(
    (step) => step.uses === 'actions/download-artifact@v4' && String(step.with?.name).startsWith('daemon-darwin'),
  );
  assert.equal(darwinDownloads.length, 2);
  assert.ok(darwinDownloads.every((step) => step.with['run-id'] === undefined));
  const daemonLeg = parse(readFileSync(new URL('../.github/actions/daemon-leg/action.yml', import.meta.url), 'utf8'));
  assert.equal(daemonLeg.inputs.reuse_run_id, undefined);
  assert.ok(!daemonLeg.runs.steps.some((step) => /artifact/.test(String(step.uses))));
  assert.ok(!daemonLeg.runs.steps.some((step) => /setup-node|rust-toolchain/.test(String(step.uses))));
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
  const publishStep = 'Publish the one GitHub release record with its release.json and stable desktop downloads';
  for (const name of [
    publishStep,
    'Notify clients without changing the authoritative release outcome',
    'Finalize the release record',
    'Remove drafts this release supersedes',
  ]) {
    const step = workflow.jobs.release_result.steps.find((candidate) => candidate.name === name);
    assert.match(step.if, /no_op != 'true'/, name);
  }
  const publish = workflow.jobs.release_result.steps.find((step) => step.name === publishStep);
  assert.match(publish.if, /steps\.result\.outputs\.outcome == 'success'/);
  // The record is on the release before it is published.
  assert.ok(publish.run.indexOf('ghr_upload_verified "$RELEASE_VERSION" "$state"') < publish.run.indexOf('ghr_publish'));
  assert.match(summary.env.NOTIFICATION_STATE, /steps\.notification\.outputs\.state/);
  const genuineFailure = workflow.jobs.release_result.steps.find((step) => step.name?.startsWith('Fail the attempt'));
  assert.equal(genuineFailure.if, "steps.result.outputs.outcome != 'success'");
  assert.match(genuineFailure.run, /exit 1/);
  // A failed release never redispatches itself; recovery is an explicit dispatch.
  assert.equal(workflow.jobs.retry, undefined);
  assert.doesNotMatch(release, /createWorkflowDispatch/);
  const resultStep = workflow.jobs.release_result.steps.find((step) => step.name === "Record each component job's result and classify the attempt");
  const otaLeg = parse(readFileSync(new URL('../.github/actions/mobile-ota-leg/action.yml', import.meta.url), 'utf8'));
  const otaPromote = otaLeg.runs.steps.find((step) => step.id === 'promote');
  assert.match(otaPromote.run, /ota-release\.mjs promote/);
  assert.match(otaPromote.run, /completed_at=\$\(date \+%s\)/);
  assert.equal(otaLeg.outputs.completed_at.value, '${{ steps.promote.outputs.completed_at }}');
  for (const job of ['mobile_ota', 'mobile_ota_after_proof']) {
    assert.equal(workflow.jobs[job].outputs.completed_at, '${{ steps.ota.outputs.completed_at }}');
    assert.equal(workflow.jobs[job].outputs.ota_branch, '${{ steps.ota.outputs.ota_branch }}');
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
  assert.match(release, /store_track:/);
  // Rollbacks read the live systems and the published release record.
  assert.match(rollback, /release-record\.mjs ota-rollback-target/);
  assert.match(rollback, /ota-release\.mjs channel-branch --channel production/);
  assert.match(serverRollback, /release-record\.mjs server-rollback-image/);
  assert.match(serverRollback, /flyctl machine list --app beeline-server --json/);
  for (const source of [rollback, serverRollback]) {
    assert.deepEqual(parse(source).concurrency, { group: 'unified-production-release', 'cancel-in-progress': false });
    assert.doesNotMatch(source, /(?:upload|download)-artifact/);
  }
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
    /retry_flyctl_update "\$canary" "\$image_ref" "canary" "\$previous_ref"\nwait_for_machine_ready "\$canary"/,
  );
  assert.match(
    promote,
    /retry_flyctl_update "\$second" "\$image_ref" "second" "\$second_previous_ref"\nwait_for_machine_ready "\$second"/,
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

test('release_result records a fully delivered slow attempt as a success', () => {
  const workflow = parse(
    readFileSync(new URL('../.github/workflows/unified-release.yml', import.meta.url), 'utf8'),
  );
  const classify = workflow.jobs.release_result.steps.find((step) => step.id === 'result');
  const repoRoot = dirname(dirname(RELEASE_SCRIPT));
  const identity = { version: 'v0.0.9', sourceSha: NEW_SHA };

  // Run the release_result classifier exactly as the job does: a fully
  // delivered attempt whose wall clock passed the old 20-minute budget.
  function classifyDeliveredAttempt(triggerAgoSeconds, { otaResult = 'success', stateOutput, previous, previousOutput, suppress = false, expectedFailure } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'beeline-release-budget-'));
    try {
      const state = initializeRelease({ ...identity, previous });
      const transport = Object.fromEntries(planOutputs(state, previous).trim().split('\n').map((line) => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
      // Replay the runner's false positive: a multiline credential registered
      // JSON punctuation as secret lines. Public encoded metadata survives.
      if (suppress) for (const key of Object.keys(transport)) {
        if (/[{}\[\]]/.test(transport[key])) delete transport[key];
      }
      const now = Math.floor(Date.now() / 1000);
      const needs = {
        initialize: { result: 'success', outputs: {
          ...Object.fromEntries(RELEASE_COMPONENTS.map((component) => [`run_${component.replace('-', '_')}`, 'true'])),
          native_android: 'true', native_ios: 'true',
        } },
        ...Object.fromEntries(['helper', 'desktop_installers', 'website',
          'mobile_native_android', 'mobile_native_ios'].map((job) => [job, { result: 'success', outputs: {} }])),
        server: { result: 'success', outputs: { image_ref: `registry.fly.io/beeline-server:0.0.9-${NEW_SHA.slice(0, 12)}`, previous_image_ref: 'registry.fly.io/beeline-server:0.0.8-111111111111' } },
        mobile_ota: { result: otaResult, outputs: { completed_at: String(now - 60), ota_branch: 'release-v0.0.9', ota_targets: 'android@40,ios@36' } },
        mobile_ota_after_proof: { result: 'skipped', outputs: {} },
      };
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
          RELEASE_STATE: stateOutput ?? transport.release_state ?? '',
          PREVIOUS_RECORD: previousOutput ?? transport.previous_record ?? '',
          GITHUB_STEP_SUMMARY: join(root, 'summary'),
          NO_OP: 'false',
          RELEASE_VERSION: identity.version,
          RELEASE_SHA: identity.sourceSha,
          RELEASE_ID: `${identity.version}-${identity.sourceSha}`,
        },
      });
      if (expectedFailure) {
        assert.match(readFileSync(join(root, 'summary'), 'utf8'), new RegExp(expectedFailure));
        assert.equal(readFileSync(output, 'utf8').includes('state_ready=false'), true);
      }
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

  const previous = deliveredPrevious();
  const masked = classifyDeliveredAttempt(26 * 60, { previous, suppress: true });
  assert.equal(masked.outcome, 'success');
  for (const [stateOutput, failure] of [['', 'release-state:missing'], ['{', 'release-state:invalid'], ['b64:broken', 'release-state:invalid'], ['null', 'release-state:invalid'], [JSON.stringify({ ...initializeRelease(identity), sourceSha: OLD_SHA }), 'release-state:invalid']]) {
    const result = classifyDeliveredAttempt(60, { stateOutput, expectedFailure: failure });
    assert.equal(result.outcome, 'failure');
    assert.equal(result.failure_class, failure);
  }
  for (const [previousOutput, failure] of [['', 'previous-record:missing'], ['{', 'previous-record:invalid'], [encodeReleaseOutput({ ...previous, sourceSha: NEW_SHA }), 'previous-record:invalid']]) {
    const result = classifyDeliveredAttempt(60, { previous, previousOutput, expectedFailure: failure });
    assert.equal(result.outcome, 'failure');
    assert.equal(result.failure_class, failure);
  }
  // Legacy raw JSON is accepted for local fixtures and same-commit reruns.
  assert.equal(classifyDeliveredAttempt(60, { stateOutput: JSON.stringify(initializeRelease(identity)) }).outcome, 'success');

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
  assert.equal(proof.needs, 'initialize');
  assert.deepEqual(proof['runs-on'], ['self-hosted', 'beeline-android']);
  assert.equal(proof['timeout-minutes'], 18);
  const steps = proof.steps;
  const stage = steps.find((step) => step.name === 'Stage the candidate OTA without promoting production');
  const run = steps.find((step) => step.name === 'Run the emulator release proof');
  const evidence = steps.find((step) => step.name === 'Preserve release-proof evidence');
  assert.equal(stage.uses, './.github/actions/mobile-ota-leg');
  assert.equal(stage.with.promote, 'false');
  assert.ok(steps.indexOf(stage) < steps.indexOf(run));
  assert.equal(run['timeout-minutes'], 5);
  assert.match(run.run, /timeout .*280s node scripts\/release-proof\.mjs --ota --sha/);
  assert.match(run.env.BEELINE_REVIEW_SECRET, /secrets\.BEELINE_REVIEW_SECRET/);
  assert.doesNotMatch(JSON.stringify(steps), /android-build\.sh|--aab|--apk|download-artifact/);
  assert.match(evidence.if, /always\(\) && steps\.proof\.conclusion != 'skipped'/);
  assert.match(evidence.with.path, /release-proof-out/);
  assert.equal(workflow.jobs.server.needs, 'initialize');
  assert.ok(!JSON.stringify(workflow.jobs.helper.needs).includes('release_proof'));

  // The proof is consent-gated: it runs only when the operator explicitly
  // dispatches with run_release_proof=true. OTA promotion never depends on
  // the proof; when the proof WAS requested and did not succeed, promotion
  // is blocked loudly. Any OTA promoted without a proof is recorded UNPROVEN
  // on the release.
  assert.match(proof.if, /inputs\.run_release_proof == true/);
  const ota = workflow.jobs.mobile_ota_after_proof;
  // The refusal runs before anything is published.
  const refuse = ota.steps.find((step) => step.name === 'Refuse promotion unless the release proof succeeded');
  assert.ok(ota.steps.indexOf(refuse) < ota.steps.findIndex((step) => step.uses === './.github/actions/mobile-ota-leg'));
  assert.equal(refuse.if, "needs.release_proof.result != 'success'");
  assert.match(refuse.run, /exit 1/);
  assert.match(refuse.run, /The proof was explicitly requested for this release, so promotion stays blocked/);
  assert.match(refuse.run, /result: \$\{\{ needs\.release_proof\.result \}\}/);
  // A requested proof always routes the OTA through the job that waits for it.
  assert.match(workflow.jobs.mobile_ota.if, /inputs\.run_release_proof != true/);

  // An unrequested proof records the unproven promotion on the release.
  const result = workflow.jobs.release_result;
  const fin = result.steps.find((step) => step.name === 'Finalize the release record');
  assert.match(fin.env.RELEASE_PROOF_UNPROVEN, /needs\.initialize\.outputs\.run_mobile_ota == 'true' && inputs\.run_release_proof != true/);
  assert.match(fin.run, /--unproven/);
  const record = result.steps.find((step) => step.name?.startsWith('Publish the one GitHub release record'));
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
  const ota = workflow.jobs.mobile_ota_after_proof;
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
  assert.equal(githubGate(ota.if, carried), true, 'the OTA waits for the requested proof in the carried shape');
  assert.equal(
    githubGate(proofIf, proofEnv({ native_android: 'false', native_result: 'skipped', requested: true })),
    true,
    'an OTA-only release has no native build to wait for',
  );
  // Native publishing is independent of the existing-binary OTA proof.
  assert.equal(githubGate(proofIf, proofEnv({ native_result: 'failure', requested: true })), true);

  // Promotion truth table: an unrequested proof routes the OTA through
  // mobile_ota, which never waits; a requested proof routes it through
  // mobile_ota_after_proof, where only a successful proof gets past the
  // refusal step that runs before anything is published.
  for (const requested of [false, true]) {
    const values = { ...proofEnv({ requested }) };
    assert.equal(githubGate(workflow.jobs.mobile_ota.if, values), !requested);
    assert.equal(githubGate(ota.if, values), requested);
  }
  for (const proof of ['success', 'failure', 'skipped', 'cancelled']) {
    assert.equal(githubGate(refuse.if, { 'needs.release_proof.result': proof }), proof !== 'success', `refuse(${proof})`);
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
    Object.entries(pendingComponents(state)).filter(([, runnable]) => runnable).map(([component]) => component),
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
    // The IPA is named for the release so Apple's upload record identifies it (see store-shipped.mjs).
    assert.match(iosBuild.run, /ipa="\$RUNNER_TEMP\/\$\(node ..\/..\/scripts\/store-shipped\.mjs ios-file-name --marker "\$\{\{ needs\.initialize\.outputs\.release_marker \}\}"\)"/);
    assert.match(iosBuild.run, /echo "IOS_IPA=\$ipa" >> "\$GITHUB_ENV"/);
    assert.match(iosBuild.run, /--output "\$ipa"/);
    assert.match(iosBuild.run, /test -s "\$ipa"/);
    assert.match(iosBuild.run, /python3 ..\/..\/scripts\/ios-build-evidence\.py "\$ipa" "\$RUNNER_TEMP\/ios-build\.json"/);
    assert.match(iosSubmit.run, /ios-store-build\.mjs prepare "\$RUNNER_TEMP\/ios-build\.json"/);
    assert.match(iosSubmit.run, /ios-store-build\.mjs verify "\$RUNNER_TEMP\/ios-build\.json" "\$RUNNER_TEMP\/ios-upload\.json"/);
    assert.ok(iosSubmit.run.indexOf('ios-store-build.mjs prepare') < iosSubmit.run.indexOf('xcrun altool --upload-app'));
    assert.ok(iosSubmit.run.indexOf('ios-store-build.mjs verify') > iosSubmit.run.indexOf('xcrun altool --upload-app'));
    assert.match(
      iosSubmit.run,
      /xcrun altool --upload-app -t ios -f "\$IOS_IPA" \\\n\s+--apiKey "\$EXPO_ASC_KEY_ID" --apiIssuer "\$EXPO_ASC_ISSUER_ID" --output-format json/,
    );
    assert.doesNotMatch(iosSubmit.run, /npx .*eas submit/);
    assert.match(cleanup.run, /rm -rf "\$RUNNER_TEMP\/private_keys"/);
    const appReview = ios.steps.find((step) => step.name === 'Send production iOS version to App Review');
    assert.equal(appReview.if, "inputs.store_track == 'production'");
    assert.match(appReview.run, /ios-store-build\.mjs submit/);
    assert.ok(ios.steps.indexOf(appReview) > ios.steps.indexOf(iosSubmit));
    // Store build numbers reach the release record through job outputs.
    const iosIdentity = ios.steps.find((step) => step.id === 'ios_identity');
    assert.ok(ios.steps.indexOf(appReview) < ios.steps.indexOf(iosIdentity));
    assert.equal(ios.outputs.build_number, '${{ steps.ios_identity.outputs.build_number }}');
    assert.equal(android.outputs.version_code,
      '${{ steps.play-upload.outputs.version_code || needs.initialize.outputs.android_version_code }}');
    // A rerun asks the stores first: a shipped platform neither builds nor uploads.
    assert.equal(androidBuild.if, "needs.initialize.outputs.android_shipped != 'true'");
    assert.match(playUpload.if, /steps\.android_build\.outcome == 'success'/);
    assert.match(playUpload.run, /RELEASE_NAME="\$\{\{ steps\.native_version\.outputs\.version \}\} \(\$\{\{ needs\.initialize\.outputs\.release_marker \}\}\)"/);
    assert.equal(iosBuild.if, "needs.initialize.outputs.ios_shipped != 'true'");
    assert.match(iosSubmit.if, /ios_shipped != 'true'/);
    assert.match(iosBuild.run, /releaseMarker/);
    const iosReuse = ios.steps.find((step) => step.name === 'Reuse the iOS build this release already shipped');
    assert.equal(iosReuse.if, "needs.initialize.outputs.ios_shipped == 'true'");
    assert.match(iosReuse.run, /store-shipped\.mjs ios-evidence/);
    assert.ok(ios.steps.indexOf(iosReuse) < ios.steps.indexOf(appReview));
    const androidEvidence = androidSteps.find((step) => step.name === 'Hand the AAB to the release proof in this run');
    assert.equal(androidEvidence.with.name, 'mobile-native-android-build-${{ needs.initialize.outputs.release_id }}');
    assert.match(androidEvidence.with.path, /android-build\.json[\s\S]*beeline\.aab/);
    assert.ok(!ios.steps.some((step) => step.uses === 'actions/upload-artifact@v4'));

    assert.equal(cleanup.if, 'always()');
    assert.match(cleanup.run, /rm -f .*AuthKey_.*"\$RUNNER_TEMP"\/beeline-\*\.ipa/);
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

test('a carried desktop re-attaches the installers of the release that built them; a rerun rebuilds in-run', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/unified-release.yml', import.meta.url), 'utf8'));
  const steps = workflow.jobs.release_result.steps;
  // No step looks for an earlier attempt's installers.
  assert.ok(!steps.some((step) => step.with?.['run-id'] || /listArtifactsForRepo/.test(step.with?.script ?? '')));
  const download = steps.find((step) => step.name === 'Download newly built stable desktop installers');
  assert.match(download.if, /run_desktop == 'true'/);
  const record = steps.find((step) => step.name?.startsWith('Publish the one GitHub release record'));
  assert.match(record.run, /if \[ "\$RUN_DESKTOP" != true \]; then/);
  assert.match(record.run, /gh release download "\$previous_version" --pattern 'Beeline-\*'/);
  const manifest = steps.find((step) => step.name === 'Build the signed desktop update manifest');
  assert.match(manifest.if, /needs\.initialize\.outputs\.run_desktop == 'true'/);
  const preserve = steps.find((step) => step.name === 'Preserve the previous updater manifest for publication rollback');
  assert.match(preserve.run, /supersedes\?\.version/);
  assert.match(preserve.run, /components\.desktop\.version/);
});

test('the helper asks Pages what shipped; a Mac bundle is carried from the published channel or built cold', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/unified-release.yml', import.meta.url), 'utf8'));
  const { helper_macos: macos, helper } = workflow.jobs;
  const shipped = macos.steps.find((step) => step.id === 'shipped');
  assert.match(shipped.run, /m\.version===process\.env\.RELEASE_VERSION&&m\.sourceCommit===process\.env\.RELEASE_SHA/);
  const download = macos.steps.find((step) => step.id === 'previous_bundle');
  const carry = macos.steps.find((step) => step.id === 'carry_bundle');
  const cold = macos.steps.find((step) => step.name === 'Build and install-verify the native helper');
  assert.match(download.with.script, /downloadPagesChannel/);
  assert.equal(download['continue-on-error'], true);
  assert.equal(carry['continue-on-error'], true);
  assert.match(carry.run, /--carry-forward/);
  for (const [downloadOutcome, carryOutcome, expectedCold] of [
    ['skipped', 'skipped', true], ['failure', 'skipped', true], ['success', 'failure', true], ['success', 'success', false],
  ]) {
    const context = { inputs: {}, needs: {}, steps: {
      shipped: { outputs: { shipped: 'false' } },
      previous_bundle: { outcome: downloadOutcome }, carry_bundle: { outcome: carryOutcome },
    } };
    assert.equal(evaluateWorkflowCondition(carry.if, context), downloadOutcome === 'success');
    assert.equal(evaluateWorkflowCondition(cold.if, context), expectedCold);
  }
  // Already on Pages: nothing builds, and the helper leg skips both phases.
  const shippedContext = { inputs: {}, needs: {}, steps: {
    shipped: { outputs: { shipped: 'true' } }, previous_bundle: { outcome: 'skipped' }, carry_bundle: { outcome: 'skipped' },
  } };
  assert.equal(evaluateWorkflowCondition(cold.if, shippedContext), false);
  for (const phase of ['build', 'promote']) {
    const leg = helper.steps.find((step) => step.uses === './.github/actions/daemon-leg' && step.with?.phase === phase);
    assert.equal(evaluateWorkflowCondition(leg.if, { inputs: {}, steps: {}, needs: { helper_macos: { outputs: { shipped: 'true' } } } }), false);
    assert.equal(evaluateWorkflowCondition(leg.if, { inputs: {}, steps: {}, needs: { helper_macos: { outputs: { shipped: 'false' } } } }), true);
  }
  // A failed Mac build never promotes a helper with missing bytes.
  const initialize = { result: 'success', outputs: { run_helper: 'true' } };
  assert.equal(evaluateWorkflowCondition(helper.if, { inputs: {}, steps: {}, needs: { initialize, helper_macos: { result: 'failure' } } }), false);
  assert.equal(evaluateWorkflowCondition(helper.if, { inputs: {}, steps: {}, needs: { initialize, helper_macos: { result: 'success' } } }), true);
  const upload = macos.steps.find((step) => step.uses === 'actions/upload-artifact@v4');
  assert.match(upload.with.path, /mac-helper-inputs\.json/);
  assert.match(upload.with.path, /beeline-bootstrap\.mjs\n/);
  assert.match(upload.with.path, /beeline-bootstrap\.mjs\.sha256/);
});

// Reproduction ARTIFACT-NOT-FOUND (run 41070446048): beta was published, then
// production promotion died on "Unable to download artifact(s): Not Found"
// because the OTA candidate ledger travelled through an Actions artifact.
test('ARTIFACT-NOT-FOUND: a rerun plans from the published record alone and reads no attempt file', () => {
  const workflow = parse(readFileSync(new URL('../.github/workflows/unified-release.yml', import.meta.url), 'utf8'));
  const plan = workflow.jobs.initialize.steps.find((step) => step.id === 'plan');
  const dir = mkdtempSync(join(tmpdir(), 'release-rerun-'));
  try {
    const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const runPlan = () => {
      writeFileSync(join(dir, 'outputs'), '');
      const result = spawnSync('bash', ['-euc', plan.run], { encoding: 'utf8', env: {
        ...process.env, RUNNER_TEMP: dir, RELEASE_SHA: sourceSha, RELEASE_VERSION: 'v0.0.9',
        SELECTION: 'all', STORE_TRACK: 'none',
        GITHUB_OUTPUT: join(dir, 'outputs'), GITHUB_STEP_SUMMARY: join(dir, 'summary'),
      } });
      assert.equal(result.status, 0, result.stderr);
      const outputs = readFileSync(join(dir, 'outputs'), 'utf8');
      return outputs.replace(/^release_state=(.+)$/m, (_, value) => `release_state=${JSON.stringify(decodeReleaseOutput(value))}`)
        .replace(/"(?:startedAt|updatedAt)":"[^"]+"/g, '');
    };
    const first = runPlan();
    assert.match(first, /^run_server=true$/m);
    assert.match(first, /^run_mobile_ota=true$/m);
    // The second attempt of the same identity plans exactly the same legs.
    assert.equal(runPlan(), first);
    assert.doesNotMatch(plan.run, /retry|attempt|artifact/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R-DESKTOP-EVIDENCE: notification diagnostics are optional while desktop build and installer uploads remain required', () => {
  const workflow = parse(readFileSync('.github/workflows/desktop.yml', 'utf8'));
  const steps = workflow.jobs.build.steps;
  for (const name of ['Capture macOS native notification', 'Capture Windows native notification']) {
    assert.equal(steps.find(step => step.name === name)['continue-on-error'], true);
  }
  const evidence = steps.find(step => step.with?.name === 'desktop-native-notification-${{ matrix.label }}');
  assert.equal(evidence['continue-on-error'], true, 'An optional screenshot upload outage must not fail the desktop build');
  assert.match(evidence.if, /pull_request/);
  assert.match(evidence.if, /merge_group/);
  for (const name of ['Build the desktop bundle', 'Prove the build produced installers']) {
    assert.notEqual(steps.find(step => step.name === name)['continue-on-error'], true);
  }
  const installers = steps.filter(step => step.uses === 'actions/upload-artifact@v4' && step !== evidence);
  assert.equal(installers.length, 2);
  for (const upload of installers) {
    assert.notEqual(upload['continue-on-error'], true);
    assert.equal(upload.with['if-no-files-found'], 'error');
  }
});

test('public JSON release outputs survive punctuation masking across plan, OTA and bookkeeping', () => {
  const previous = deliveredPrevious();
  const state = initializeRelease({ version: 'v0.0.9', sourceSha: NEW_SHA, previous });
  const outputs = Object.fromEntries(planOutputs(state, previous).trim().split('\n').map((line) => {
    const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)];
  }));
  for (const key of ['release_state', 'previous_record', 'ota_memory']) {
    assert.doesNotMatch(outputs[key], /[{}\[\]]/);
    assert.equal(typeof decodeReleaseOutput(outputs[key]), 'object');
  }
  const workflow = parse(readFileSync('.github/workflows/unified-release.yml', 'utf8'));
  const ota = parse(readFileSync('.github/actions/mobile-ota-leg/action.yml', 'utf8'));
  const publish = ota.runs.steps.find((step) => step.id === 'publish');
  assert.match(publish.run, /store_runtime=\$\{encodeReleaseOutput/);
  const memory = ota.runs.steps.find((step) => step.name === 'Read the live store runtimes');
  assert.match(memory.run, /release-job-output.mjs OTA_MEMORY/);
  assert.match(workflow.jobs.bookkeeping.steps.at(-1).run, /release-job-output.mjs PREVIOUS_RECORD/);
  assert.equal(workflow.jobs.release_result.steps.find((step) => step.name === 'Surface release outcome and duration').if,
    "steps.result.outputs.state_ready != 'false'");
  const dir = mkdtempSync(join(tmpdir(), 'release-public-output-'));
  try {
    const output = join(dir, 'decoded.json');
    const result = spawnSync(process.execPath, ['scripts/release-job-output.mjs', 'PREVIOUS_RECORD', output], {
      env: { ...process.env, PREVIOUS_RECORD: outputs.previous_record }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), previous);
    // A same-head no-op passes the published record as both state and previous;
    // its supersedes identity still points at the older release.
    const published = { ...previous, plan: { selected: RELEASE_COMPONENTS, carried: [] }, delivery: { state: 'success' }, supersedes: { version: 'v0.0.7', sourceSha: OLD_SHA } };
    const restored = spawnSync(process.execPath, [RELEASE_SCRIPT, 'restore-job-state', '--state', output, '--previous', join(dir, 'previous.json')], {
      env: { ...process.env, RELEASE_STATE: encodeReleaseOutput(published), PREVIOUS_RECORD: encodeReleaseOutput(published),
        RELEASE_VERSION: published.version, RELEASE_SHA: published.sourceSha, GITHUB_OUTPUT: join(dir, 'outputs') }, encoding: 'utf8',
    });
    assert.equal(restored.status, 0, restored.stderr);
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), published);
    const otaState = structuredClone(state);
    applyComponentCheckpoints(otaState, checkpointsFromJobs({
      initialize: { outputs: { run_mobile_ota: 'true' } },
      mobile_ota: { result: 'success', outputs: {} },
    }, { version: state.version, sourceSha: state.sourceSha }));
    const observations = { previouslyLive: [{ platform: 'ios', runtimeVersion: '36' }] };
    applyJobFacts(otaState, { mobile_ota: { result: 'success', outputs: {
      ota_branch: 'release-v0.0.9', ota_targets: 'ios@36', store_runtime: encodeReleaseOutput(observations),
    } } }, { previous });
    assert.deepEqual(otaState.storeRuntime.previouslyLive, observations.previouslyLive);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
