import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  applyComponentCheckpoints,
  changedPathsFromPublishedInputs,
  COMPONENT_PATH_RULES,
  createServerImageLedger,
  evaluateServerCanarySample,
  evaluateServerCanaryWindow,
  RELEASE_BUDGET_MINUTES,
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
const NEW_SHA = '2'.repeat(40);
const RELEASE_SCRIPT = fileURLToPath(new URL('./unified-release.mjs', import.meta.url));

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
    'watch:a-machine:300s',
    'update:b-machine:registry.fly.io/beeline-server:new',
  ]);
  assert.deepEqual(plan.rollbackSteps, [
    'update:a-machine:registry.fly.io/beeline-server:old',
    'fail-release',
  ]);
  assert.throws(() => planServerCanaryDeployment(machines.slice(0, 1), 'registry.fly.io/beeline-server:new'), /exactly two/);
  assert.throws(() => planServerCanaryDeployment([
    machines[0], { id: 'c', config: { image: 'registry.fly.io/beeline-server:other' } },
  ], 'registry.fly.io/beeline-server:new'), /already split/);
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

test('server deployment dry-run prints both success and rollback ordering', () => {
  const root = mkdtempSync(join(tmpdir(), 'beeline-canary-plan-'));
  try {
    const machines = join(root, 'machines.json');
    writeFileSync(machines, JSON.stringify([
      { id: 'a', config: { image: 'registry.fly.io/beeline-server:old' } },
      { id: 'b', config: { image: 'registry.fly.io/beeline-server:old' } },
    ]));
    const output = run('node', [RELEASE_SCRIPT, 'server-deploy-plan', '--machines', machines,
      '--image', 'registry.fly.io/beeline-server:new', '--simulate-failure', 'true'], root);
    assert.match(output, /migrate -> update:a:.*:new -> watch:a:300s -> update:b:.*:new/);
    assert.match(output, /canary failed -> update:a:.*:old -> fail-release/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('component selection follows the explicit path map', () => {
  assert.deepEqual(selectReleaseComponents(['apps/server/src/index.ts']), ['server']);
  assert.deepEqual(selectReleaseComponents(['apps/body/src/index.ts']), ['helper']);
  assert.deepEqual(selectReleaseComponents(['relay-stack/web/index.html']), ['website']);
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
    ['server', 'helper', 'mobile-ota', 'desktop'],
  );
  assert.deepEqual(
    selectReleaseComponents(['apps/mobile/sources/components/Ledger.tsx']),
    ['mobile-ota', 'desktop', 'website'],
  );
  assert.deepEqual(
    selectReleaseComponents(['apps/mobile/app.config.js']),
    ['mobile-ota', 'mobile-native', 'desktop', 'website'],
  );
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
    'desktop',
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
  assert.deepEqual(selected, ['mobile-ota', 'desktop', 'website']);
  assert.deepEqual(state.plan.selected, ['mobile-ota', 'desktop', 'website']);
  assert.equal(state.components.server.sourceSha, NEW_SHA);
  assert.equal(state.components.helper.sourceSha, OLD_SHA);
  for (const component of selected) {
    assert.equal(state.components[component].state, 'pending');
    assert.equal(state.components[component].sourceSha, NEW_SHA);
  }

  for (const stage of ['built', 'promoted', 'checked']) markComponentStage(state, 'mobile-ota', stage);
  markComponentStage(state, 'desktop', 'built');
  const retry = initializeRelease({
    version,
    sourceSha: NEW_SHA,
    retry: state,
  });
  assert.equal(retry.components['mobile-ota'].state, 'checked');
  assert.equal(retry.components.desktop.state, 'built');
  assert.deepEqual(retryPlan(retry), {
    server: false,
    helper: false,
    'mobile-ota': false,
    'mobile-native': false,
    desktop: true,
    website: true,
  });

  for (const stage of ['promoted', 'checked']) markComponentStage(retry, 'desktop', stage);
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
    'mobile-ota', 'desktop', 'website',
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
    });
  }
  assert.match(releasePlanSummary(state).carried.helper, /^v0\.0\.8@1111/);
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
});

test('release notification timeout is a bounded warning', async () => {
  const result = await notifyRelease({
    version: 'v0.0.9',
    sourceSha: NEW_SHA,
    repository: 'lunchboxfortwo/beeline',
    secret: 'secret',
    timeoutMs: 10,
    fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
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

test('workflow is manual, selective, concurrent, bounded, and component-local on retry', () => {
  const source = readFileSync(new URL('../.github/workflows/unified-release.yml', import.meta.url), 'utf8');
  const workflow = parse(source);
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.equal(inputs.release_sha.required, false);
  assert.equal(inputs.release_version.required, false);
  assert.equal(inputs.retry_attempt.default, '1');
  assert.equal(inputs.selection.default, 'auto');
  assert.equal(inputs.store_track.default, 'none');
  assert.equal(inputs.plan_only.default, false);
  for (const input of Object.values(inputs)) assert.match(input.description, /Recovery only/);
  assert.equal(workflow.jobs.initialize['timeout-minutes'], 2);
  assert.equal(workflow.jobs.release_result['timeout-minutes'], 2);
  assert.equal(RELEASE_BUDGET_MINUTES, 20);
  assert.match(source, /release ceiling is 20 minutes/);
  assert.doesNotMatch(source.replace(/  mobile_native:[\s\S]*?\n  release_result:/, ''), /timeout-minutes:\s*(?:[2-9][0-9]|[1-9][0-9]{2,})/);
  assert.doesNotMatch(source, /wait_minutes=35|timeout-minutes:\s*55/);
  assert.match(source, /selection:[\s\S]*default: auto/);
  assert.match(source, /description: Recovery only - routine releases keep auto/);
  assert.match(source, /release-version --previous "\$previous" --sha "\$release_sha"/);
  assert.match(source, /if \[ "\$PLAN_ONLY" = true \]; then/);
  assert.match(source, /release_sha=\$\(git rev-parse HEAD\)/);
  assert.match(source, /release_version=v0\.0\.0/);
  assert.match(source, /release_sha="\$\{REQUESTED_SHA:-\$GITHUB_SHA\}"/);
  assert.match(source, /git merge-base --is-ancestor "\$release_sha" origin\/main/);
  assert.match(source, /unified-release\.mjs component-paths/);
  assert.match(source, /--component-paths "\$RUNNER_TEMP\/release-component-paths\.json"/);
  assert.match(source, /needs\.initialize\.outputs\.run_server == 'true'/);
  assert.match(source, /needs\.initialize\.outputs\.run_helper == 'true'/);
  assert.match(source, /needs\.initialize\.outputs\.run_mobile_ota == 'true'/);
  assert.deepEqual(workflow.jobs.mobile_ota.needs, ['initialize', 'mobile_native']);
  assert.match(workflow.jobs.mobile_ota.if, /runtime_pin_changed != 'true'/);
  assert.match(workflow.jobs.mobile_ota.if, /stage_mobile_native == 'checked'/);
  assert.match(workflow.jobs.mobile_ota.if, /needs\.mobile_native\.result == 'success'/);
  assert.match(source, /needs\.initialize\.outputs\.run_desktop == 'true'/);
  assert.match(source, /needs\.initialize\.outputs\.run_website == 'true'/);
  assert.equal(workflow.jobs.server_deploy_plan.if, 'inputs.plan_only == true');
  for (const job of ['server', 'helper', 'mobile_ota', 'desktop_installers', 'desktop_checkpoint', 'website', 'mobile_native', 'release_result', 'retry']) {
    assert.match(String(workflow.jobs[job].if), /inputs\.plan_only != true/);
  }
  assert.match(source, /release-checkpoint-\$\{\{ needs\.initialize\.outputs\.release_id \}\}-server/);
  assert.match(source, /release-checkpoint-\$\{\{ needs\.initialize\.outputs\.release_id \}\}-helper/);
  assert.match(source, /stage_server:[\s\S]*stage_helper:[\s\S]*stage_mobile_ota:/);
  assert.match(source, /stage_server == 'pending'/);
  assert.match(source, /\["pending","built"\][\s\S]*stage_server/);
  assert.match(source, /failure_class/);
  assert.match(source, /durationSeconds/);
  assert.match(source, /rolling [0-9]+ release attempts/);
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
  assert.match(release, /node scripts\/server-release-smoke\.mjs/);
  assert.match(release, /BEELINE_REVIEW_SECRET: \$\{\{ secrets\.BEELINE_REVIEW_SECRET \}\}/);
  assert.match(release, /unified-release\.mjs notify/);
  const notification = workflow.jobs.release_result.steps.find((step) => step.id === 'notification');
  assert.equal(notification['continue-on-error'], true);
  const summary = workflow.jobs.release_result.steps.find((step) => step.name?.startsWith('Surface release outcome'));
  assert.match(summary.env.NOTIFICATION_STATE, /no_op == 'true'/);
  for (const name of [
    'Publish immutable attempt state for component-local retry',
    'Create the one GitHub release record and preserve stable desktop downloads',
    'Notify clients without changing the authoritative release outcome',
    'Finalize successful delivery after every selected promotion and record',
    'Publish the one successful release index',
  ]) {
    const step = workflow.jobs.release_result.steps.find((candidate) => candidate.name === name);
    assert.match(step.if, /no_op != 'true'/);
  }
  assert.match(summary.env.NOTIFICATION_STATE, /steps\.notification\.outputs\.state/);
  const genuineFailure = workflow.jobs.release_result.steps.find((step) => step.name?.startsWith('Fail the attempt'));
  assert.equal(genuineFailure.if, "steps.result.outputs.outcome != 'success'");
  assert.match(genuineFailure.run, /exit 1/);
  assert.match(workflow.jobs.retry.if, /needs\.release_result\.result == 'failure'/);
  assert.match(release, /unified-release-index/);
  assert.match(release, /store_track:/);
  assert.match(rollback, /mobile-ota-rollback-/);
  assert.match(serverRollback, /server-image-ledger-/);
  assert.match(serverRollback, /default: true/);
  assert.match(serverRollback, /flyctl machine update/);
  assert.match(serverLeg, /MIGRATION_DATABASE_URL/);
  const setupNodeIndex = workflow.jobs.server.steps.findIndex((step) => step.uses === 'actions/setup-node@v4');
  const prepareMigrationIndex = workflow.jobs.server.steps.findIndex((step) => step.name === 'Prepare the server migration CLI once');
  const promoteIndex = workflow.jobs.server.steps.findIndex((step) => step.uses === './.github/actions/server-leg' && step.with?.phase === 'promote');
  assert.ok(setupNodeIndex > 0 && setupNodeIndex < prepareMigrationIndex && prepareMigrationIndex < promoteIndex);
  assert.equal(workflow.jobs.server.steps[setupNodeIndex].with['node-version-file'], '.nvmrc');
  assert.equal(workflow.jobs.server.steps[setupNodeIndex].with.cache, 'npm');
  const prepareMigration = workflow.jobs.server.steps[prepareMigrationIndex].run;
  assert.match(prepareMigration, /^npm ci$/m);
  assert.doesNotMatch(prepareMigration, /--ignore-scripts|@beeline\/gate/);
  for (const workspace of ['nostr', 'api-contract', 'buzz-client', 'body', 'auth', 'push-gateway', 'server']) {
    assert.match(prepareMigration, new RegExp(`npm run build -w @beeline/${workspace}`));
  }
  const migrationStep = serverLegAction.runs.steps.find((step) => step.name === 'Run schema migrations and backfills once before Machine updates');
  const migrate = migrationStep.run;
  assert.equal(migrationStep.env.SERVER_DB_DIRECT_IP, 'fdaa:67:2f3e:0:1::11');
  assert.match(migrate, /MIGRATION_DATABASE_URL is required/);
  assert.match(migrate, /flyctl proxy "15432:5432" "\$SERVER_DB_DIRECT_IP" -a beeline-server/);
  assert.match(migrate, /trap 'kill "\$proxy_pid".*wait "\$proxy_pid"/);
  assert.match(migrate, /\/dev\/tcp\/127\.0\.0\.1\/15432/);
  assert.match(migrate, /database proxy did not open within 30s/);
  assert.match(migrate, /current_database\(\) AS database/);
  assert.match(migrate, /to_regclass\('public\.messages'\) IS NOT NULL AS has_messages/);
  assert.match(migrate, /database !== 'fly-db' \|\| hasMessages !== true/);
  assert.match(migrate, /MIGRATION_DATABASE_URL does not point at the production database/);
  assert.ok(migrate.indexOf('database !== \'fly-db\'') < migrate.indexOf('npm run migrate -w @beeline/server'));
  assert.match(migrate, /npm run migrate -w @beeline\/server/);
  assert.doesNotMatch(migrate, /npm ci|npm run build/);
  assert.match(serverLeg, /seq 0 20/);
  assert.match(serverLeg, /sleep 15/);
  assert.match(serverLeg, /fly-force-instance-id/);
  assert.match(serverLeg, /server\.usebeeline\.app\/health(?:\s|\\)/);
  assert.doesNotMatch(serverLeg, /server\.usebeeline\.app\/healthz/);
  const promote = serverLegAction.runs.steps.find((step) => step.name === 'Canary one Machine, observe for five minutes, then update its peer').run;
  assert.match(release, /SERVER_CANARY_REVIEW_SECRET: \$\{\{ secrets\.SERVER_CANARY_REVIEW_SECRET \}\}/);
  assert.match(release, /SERVER_CANARY_ROOM_ID: \$\{\{ secrets\.SERVER_CANARY_ROOM_ID \}\}/);
  assert.match(promote, /v1\/auth\/review\/exchange/);
  assert.match(promote, /JSON\.stringify\(\{ secret: process\.env\.SERVER_CANARY_REVIEW_SECRET \}\)/);
  assert.match(promote, /::add-mask::\$canary_access_token/);
  assert.match(promote, /::add-mask::\$canary_refresh_token/);
  assert.match(promote, /Authorization: Bearer \$canary_access_token/);
  assert.match(promote, /SERVER_CANARY_REVIEW_SECRET is unset; using the legacy canary phone token/);
  assert.match(promote, /requires SERVER_CANARY_REVIEW_SECRET or SERVER_CANARY_PHONE_TOKEN/);
  assert.ok(promote.indexOf('/v1/auth/review/exchange') < promote.indexOf('for sample in $(seq 0 20)'));
  assert.equal(promote.match(/v1\/auth\/review\/exchange/g)?.length, 1);
  assert.match(promote, /wait_for_machine_ready\(\)/);
  assert.match(promote, /deadline=\$\(\(SECONDS \+ 180\)\)/);
  assert.match(promote, /server\.usebeeline\.app\/readyz/);
  assert.match(promote, /did not become ready within 180s/);
  assert.match(promote, /wait_for_machine_ready "\$canary"/);
  assert.match(promote, /wait_for_machine_ready "\$second"/);
  assert.match(
    promote,
    /flyctl machine update "\$canary" --app beeline-server --image "\$image_ref" --wait-timeout 300 --yes\nwait_for_machine_ready "\$canary"/,
  );
  assert.match(
    promote,
    /flyctl machine update "\$second" --app beeline-server --image "\$image_ref" --wait-timeout 300 --yes\nwait_for_machine_ready "\$second"/,
  );
  assert.ok(promote.indexOf('wait_for_machine_ready "$canary"') < promote.indexOf('/v1/auth/review/exchange'));
  assert.match(promote, /v\.version === process\.argv\[2\]/);
  assert.match(promote, /for exchange_attempt in 1 2 3/);
  assert.match(promote, /-H "fly-force-instance-id: \$second" -H 'Content-Type: application\/json'/);
  assert.match(promote, /5\?\?\) ;;/);
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
  const command = 'gh-axi workflow run unified-release.yml --ref main';
  assert.match(guide, new RegExp(command.replaceAll('.', '\\.')));
  assert.match(agents, new RegExp(command.replaceAll('.', '\\.')));
  assert.match(guide, /Pass no inputs/);
  assert.match(agents, /with no release worker and no inputs/);
});

test('native workflow builds and submits only the selected platform', () => {
  const workflow = parse(
    readFileSync(new URL('../.github/workflows/unified-release.yml', import.meta.url), 'utf8'),
  );
  const steps = workflow.jobs.mobile_native.steps;
  const build = steps.find(
    (step) => step.name === 'Build immutable store binaries for selected platforms',
  );
  const credentials = steps.find((step) => step.name === 'Require native release credentials');
  const project = mkdtempSync(join(tmpdir(), 'beeline-native-platforms-'));
  try {
    for (const platform of ['android', 'ios']) {
      const root = join(project, platform);
      mkdirSync(root);
      const env = {
        ...process.env,
        RUNNER_TEMP: root,
        EAS_CLI_VERSION: 'test',
        NATIVE_ANDROID: String(platform === 'android'),
        NATIVE_IOS: String(platform === 'ios'),
        EXPO_TOKEN: 'fixture',
      };
      if (platform === 'android') {
        delete env.EXPO_ASC_KEY_ID;
        delete env.EXPO_ASC_ISSUER_ID;
        delete env.EXPO_ASC_API_KEY_P8;
        execFileSync('bash', ['-euc', credentials.run], { env });
      }
      execFileSync(
        'bash',
        [
          '-euc',
          `npm() { :; }
          npx() { printf '%s\\n' "$*" >> "$RUNNER_TEMP/calls"; printf '{"id":"fixture","status":"FINISHED"}'; }
          ${build.run}`,
        ],
        { env },
      );
      const calls = readFileSync(join(root, 'calls'), 'utf8').trim().split('\n');
      assert.equal(calls.length, 1);
      assert.match(calls[0], new RegExp(`--platform ${platform} `));
    }
    for (const step of steps.filter((step) =>
      ['Authenticate to Google Play', 'Upload Android to the selected Play track'].includes(step.name)
    )) {
      assert.match(step.if, /native_android == 'true'/);
    }
    assert.match(
      steps.find((step) => step.name?.startsWith('Submit iOS')).if,
      /native_ios == 'true'/,
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
