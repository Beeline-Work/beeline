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
  DESKTOP_VERSION_BASELINE,
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
const MID_SHA = '3'.repeat(40);
const NEW_SHA = '2'.repeat(40);
const RELEASE_SCRIPT = fileURLToPath(new URL('./unified-release.mjs', import.meta.url));

test('the release planner reads its desktop migration floor from the Tauri version file', () => {
  const desktopVersion = JSON.parse(readFileSync(
    new URL('../apps/mobile/src-tauri/desktop-version.json', import.meta.url), 'utf8',
  )).version;
  assert.equal(DESKTOP_VERSION_BASELINE, desktopVersion);
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
  assert.deepEqual(
    selectReleaseComponents(['apps/mobile/scripts/ota-release.mjs']),
    ['mobile-ota'],
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
  assert.equal(inputs.run_release_proof.default, false);
  assert.equal(inputs.run_release_proof.type, 'boolean');
  const consentOnly = ['release_sha', 'release_version', 'retry_attempt', 'selection', 'store_track', 'plan_only'];
  for (const name of consentOnly) assert.match(inputs[name].description, /Recovery only|Opt-in only|routine releases keep/, `${name} description`);
  assert.equal(workflow.jobs.initialize['timeout-minutes'], 2);
  assert.equal(workflow.jobs.release_result['timeout-minutes'], 2);
  assert.equal(RELEASE_BUDGET_MINUTES, 20);
  assert.match(source, /release ceiling is 20 minutes/);
  assert.doesNotMatch(
    source
      .replace(/  release_proof:[\s\S]*?\n  mobile_ota:/, '')
      .replace(/  mobile_native_android:[\s\S]*?\n  release_result:/, ''),
    /timeout-minutes:\s*(?:[2-9][0-9]|[1-9][0-9]{2,})/,
  );
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
  assert.deepEqual(workflow.jobs.mobile_ota.needs, ['initialize', 'mobile_native_android', 'mobile_native_ios', 'release_proof']);
  assert.match(workflow.jobs.mobile_ota.if, /runtime_pin_changed != 'true'/);
  assert.match(workflow.jobs.mobile_ota.if, /stage_mobile_native == 'checked'/);
  assert.match(workflow.jobs.mobile_ota.if, /needs\.mobile_native_android\.result == 'success'/);
  assert.match(workflow.jobs.mobile_ota.if, /needs\.mobile_native_ios\.result == 'success'/);
  assert.deepEqual(workflow.jobs.release_result.needs, [
    'initialize', 'server', 'helper', 'mobile_ota', 'mobile_native_android', 'mobile_native_ios',
    'desktop_installers', 'desktop_checkpoint', 'website', 'release_proof',
  ]);
  assert.doesNotMatch(source, /needs\.mobile_native\.result/);
  assert.match(source, /needs\.initialize\.outputs\.run_desktop == 'true'/);
  assert.match(source, /needs\.initialize\.outputs\.run_website == 'true'/);
  assert.equal(workflow.jobs.server_deploy_plan.if, 'inputs.plan_only == true');
  for (const job of ['server', 'helper', 'mobile_ota', 'desktop_installers', 'desktop_checkpoint', 'website', 'mobile_native_android', 'mobile_native_ios', 'release_proof', 'release_result', 'retry']) {
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
  // A cancelled run (including cancel-in-progress) is terminal for the
  // identity: the retry job must never fire for it.
  assert.match(workflow.jobs.retry.steps.find((step) => step.name?.startsWith('Refuse to re-dispatch a cancelled run')).uses, /actions\/github-script@v7/);
  assert.match(release, /this run was cancelled; cancellation is terminal for the release identity/);
  // Termination gates: machines touched / failed release migration /
  // cancelled attempt are recorded by release_result and stamped into the
  // published attempt state; the initialize plan step refuses a terminated
  // identity, and the retry job refuses to fire on it.
  assert.match(release, /needs\.release_result\.outputs\.terminated != 'true'/);
  const resultStep = workflow.jobs.release_result.steps.find((step) => step.name === 'Merge checkpoints and classify the final attempt');
  assert.match(resultStep.run, /machinesTouched/);
  assert.match(resultStep.run, /migrationFailed/);
  assert.match(resultStep.run, /server-gates\/gates\.json/);
  assert.match(resultStep.run, /terminated_reason=cancelled/);
  assert.match(release, /Stamp the terminated identity into the published attempt state/);
  const stampStep = workflow.jobs.release_result.steps.find((step) => step.name?.startsWith('Stamp the terminated identity'));
  assert.match(stampStep.if, /steps\.result\.outputs\.terminated == 'true'/);
  assert.match(stampStep.run, /state\.terminated = true/);
  const planStep = workflow.jobs.initialize.steps.find((step) => step.name?.includes('release plan'));
  assert.match(planStep.run, /was terminated; a terminated identity never retries/);
  assert.equal(workflow.jobs.release_result.outputs.terminated, "${{ steps.result.outputs.terminated }}");
  const gatesStep = workflow.jobs.server.steps.find((step) => step.name === 'Collect the server retry gates');
  assert.match(gatesStep.if, /steps\.promote\.conclusion != 'skipped'/);
  assert.match(release, /server-retry-gates-\$\{\{ needs\.initialize\.outputs\.release_id \}\}/);
  const serverLegActionSteps = serverLegAction.runs.steps;
  const migrationIndex = serverLegActionSteps.findIndex((step) => step.name === 'Run schema migrations and backfills once before Machine updates');
  const canaryIndex = serverLegActionSteps.findIndex((step) => step.name === 'Canary one Machine, observe for five minutes, then update its peer');
  assert.ok(migrationIndex < canaryIndex);
  assert.match(serverLegActionSteps[canaryIndex].run, /machines-touched\.json/);
  assert.ok(serverLegActionSteps[canaryIndex].run.indexOf('machines-touched.json') < serverLegActionSteps[canaryIndex].run.indexOf('retry_flyctl_update "$canary" "$image_ref" "canary"'));
  const migrationFailedStep = serverLegActionSteps.find((step) => step.name === 'Record a failed release migration for retry gating');
  assert.equal(migrationFailedStep.if, "inputs.phase == 'promote' && always() && steps.migrate.outcome == 'failure'");
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
    /retry_flyctl_update "\$canary" "\$image_ref" "canary"\nwait_for_machine_ready "\$canary"/,
  );
  assert.match(
    promote,
    /retry_flyctl_update "\$second" "\$image_ref" "second"\nwait_for_machine_ready "\$second"/,
  );
  assert.ok(promote.indexOf('wait_for_machine_ready "$canary"') < promote.indexOf('/v1/auth/review/exchange'));
  assert.match(promote, /v\.version === process\.argv\[2\]/);
  assert.match(promote, /for exchange_attempt in 1 2 3/);
  assert.match(promote, /-H "fly-force-instance-id: \$canary" -H 'Content-Type: application\/json'/);
  assert.match(promote, /5\?\?\) ;;/);
  // Verify the final convergence check polls for up to 180s before declaring a split.
  assert.match(promote, /verify_machine_convergence "\$image_ref" 180/);
  assert.match(promote, /max_wait="\$\{2:-0\}"/);
  assert.match(promote, /deadline=\$[\(]\(SECONDS \+ max_wait\)\)/);
  assert.match(promote, /Machines not yet converged, retrying in/);
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
  const command = 'gh-axi workflow run unified-release.yml --ref main';
  assert.match(guide, new RegExp(command.replaceAll('.', '\\.')));
  assert.match(agents, new RegExp(command.replaceAll('.', '\\.')));
  assert.match(guide, /Pass no inputs/);
  assert.match(agents, /with no release worker and no inputs/);
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
  assert.match(apk.run, /npm ci/);
  assert.match(apk.run, /npm run eas-build-post-install/);
  assert.ok(
    apk.run.indexOf('npm ci') < apk.run.indexOf('npm run eas-build-post-install'),
    'eas-build-post-install must run after npm ci',
  );
  // The runner's system node is older than metro-config's use of
  // Array.prototype.toReversed, so the proof job must pin the same node
  // version the native build bundles on.
  const proofNode = steps.find((step) => step.uses === 'actions/setup-node@v4');
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
  const ota = workflow.jobs.mobile_ota;
  const promote = ota.steps.find((step) => step.uses === './.github/actions/mobile-ota-leg' && step.with.phase === 'promote');
  assert.match(promote.if, /needs\.release_proof\.result == 'success' \|\| inputs\.run_release_proof != true/);
  const refuse = ota.steps.find((step) => step.name === 'Refuse promotion unless the release proof succeeded');
  assert.equal(refuse.if, "inputs.run_release_proof == true && needs.release_proof.result != 'success'");
  assert.match(refuse.run, /exit 1/);
  assert.match(refuse.run, /The proof was explicitly requested for this release, so promotion stays blocked/);
  assert.match(refuse.run, /result: \$\{\{ needs\.release_proof\.result \}\}/);
  for (const step of ota.steps.filter((step) =>
    [
      'Checkpoint OTA promotion',
      'Locate promoted OTA evidence for a check-only retry',
      'Require rollback evidence and write checkpoint',
    ].includes(step.name),
  )) {
    assert.match(step.if, /needs\.release_proof\.result == 'success' \|\| inputs\.run_release_proof != true/);
  }

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
  const ota = workflow.jobs.mobile_ota;
  const promote = ota.steps.find((step) => step.uses === './.github/actions/mobile-ota-leg' && step.with.phase === 'promote');
  const refuse = ota.steps.find((step) => step.name === 'Refuse promotion unless the release proof succeeded');

  const proofEnv = ({ native_android = 'true', native_result = 'success', run_mobile_ota = 'true', requested = false } = {}) => ({
    'inputs.plan_only': false,
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
  assert.equal(ios.steps.some((step) => step.uses === 'actions/setup-node@v4'), false);

  const androidSteps = android.steps;
  const androidBuild = androidSteps.find((step) => step.name === 'Build immutable Android store binary locally');
  const credentials = androidSteps.find((step) => step.name === 'Require native release credentials');
  const project = mkdtempSync(join(tmpdir(), 'beeline-native-platforms-'));
  try {
    const env = { ...process.env, RUNNER_TEMP: project, EAS_CLI_VERSION: 'test', EXPO_TOKEN: 'fixture' };
    execFileSync('bash', ['-euc', credentials.run], { env });
    // The Android leg builds on the self-hosted Linux runner (PR #1229): one
    // pinned eas-cli, --package + env -u for the same reasons as the iOS leg,
    // and a local build that writes the aab straight into RUNNER_TEMP.
    assert.match(androidBuild.run, /for candidate in "\$\{ANDROID_HOME:-\}" \/home\/lunchbox\/android-sdk "\$HOME\/Android\/Sdk"/);
    assert.match(androidBuild.run, /test -d "\$\{ANDROID_HOME:-\}\/platform-tools"/);
    assert.match(
      androidBuild.run,
      /npx --yes --package="eas-cli@\$EAS_CLI_VERSION" -- env -u npm_config_package eas build --local --platform android --profile production-ci --non-interactive --output "\$RUNNER_TEMP\/beeline\.aab"/,
    );
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
      assert.match(step.run, /export PATH=\/usr\/local\/opt\/node@20\/bin:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin:\/usr\/local\/bin/);
    }
    assert.match(iosCredentials.run, /EXPO_APPLE_TEAM_ID=89KT3SWYAF/);
    assert.match(iosCredentials.run, /EXPO_NO_CAPABILITY_SYNC=1/);
    assert.match(iosCredentials.run, /EAS_SKIP_AUTO_FINGERPRINT=1/);
    assert.match(iosBuild.run, /build --local --platform ios --profile production-ci --non-interactive --output/);
    assert.match(iosBuild.run, /test -s "\$RUNNER_TEMP\/beeline-ios\.ipa"/);
    assert.match(iosBuild.run, /id:`local-\$\{sha256\}`/);
    assert.match(
      iosSubmit.run,
      /xcrun altool --upload-app -t ios -f "\$RUNNER_TEMP\/beeline-ios\.ipa" \\\n\s+--apiKey "\$EXPO_ASC_KEY_ID" --apiIssuer "\$EXPO_ASC_ISSUER_ID" --output-format json/,
    );
    assert.doesNotMatch(iosSubmit.run, /npx .*eas submit/);
    assert.match(cleanup.run, /rm -rf "\$RUNNER_TEMP\/private_keys"/);
    const androidEvidence = androidSteps.find((step) => step.name === 'Preserve Android build evidence');
    const iosEvidence = ios.steps.find((step) => step.name === 'Preserve iOS build evidence');
    assert.equal(androidEvidence.with.name, 'mobile-native-android-build-${{ needs.initialize.outputs.release_id }}');
    assert.match(androidEvidence.with.path, /android-build\.json[\s\S]*beeline\.aab/);
    assert.equal(iosEvidence.with.name, 'mobile-native-ios-build-${{ needs.initialize.outputs.release_id }}');
    assert.equal(iosEvidence.with.path, '${{ runner.temp }}/ios-build.json');

    const releaseSteps = workflow.jobs.release_result.steps;
    const collectEvidence = releaseSteps.find((step) => step.name === 'Collect successful native build evidence');
    const preserveEvidence = releaseSteps.find((step) => step.name === 'Preserve native build evidence');
    const checkpoint = releaseSteps.find((step) => step.name === 'Write native checkpoint');
    const publishCheckpoint = releaseSteps.find((step) => step.name === 'Publish native checkpoint');
    for (const step of [collectEvidence, preserveEvidence, checkpoint, publishCheckpoint]) {
      assert.match(step.if, /native_android != 'true'.*mobile_native_android\.result == 'success'/s);
      assert.match(step.if, /native_ios != 'true'.*mobile_native_ios\.result == 'success'/s);
    }
    assert.equal(collectEvidence.with.pattern, 'mobile-native-*-build-${{ needs.initialize.outputs.release_id }}');
    assert.equal(preserveEvidence.with.name, 'mobile-native-${{ needs.initialize.outputs.release_id }}');
    assert.match(checkpoint.run, /checkpoint-mobile-native\.json/);
    assert.match(checkpoint.run, /component:"mobile-native"/);
    assert.equal(publishCheckpoint.with.name, 'release-checkpoint-${{ needs.initialize.outputs.release_id }}-mobile-native');
    assert.equal(publishCheckpoint.with.path, '${{ runner.temp }}/checkpoints/checkpoint-mobile-native.json');
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
