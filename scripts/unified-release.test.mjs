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
  RELEASE_BUDGET_MINUTES,
  RELEASE_COMPONENTS,
  RELEASE_NOTIFY_TIMEOUT_MS,
  RELEASE_NOTIFY_ENDPOINT,
  finalizeRelease,
  initializeRelease,
  markComponentStage,
  notifyRelease,
  releasePlanSummary,
  retryPlan,
  selectReleaseComponents,
  selectReleaseComponentsFromPublishedInputs,
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
    ['mobile-ota', 'desktop'],
  );
  assert.deepEqual(
    selectReleaseComponents(['apps/mobile/app.config.js']),
    ['mobile-ota', 'mobile-native', 'desktop'],
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
    assert.deepEqual(state.plan.selected, ['mobile-ota', 'desktop']);
    assert.deepEqual(summary.selected, ['mobile-ota', 'desktop']);
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
  assert.deepEqual(selected, ['mobile-ota', 'desktop']);
  assert.deepEqual(state.plan.selected, ['mobile-ota', 'desktop']);
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
    website: false,
  });

  for (const stage of ['promoted', 'checked']) markComponentStage(retry, 'desktop', stage);
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
  for (const input of Object.values(inputs)) assert.match(input.description, /Recovery only/);
  assert.equal(workflow.jobs.initialize['timeout-minutes'], 2);
  assert.equal(workflow.jobs.release_result['timeout-minutes'], 2);
  assert.equal(RELEASE_BUDGET_MINUTES, 20);
  assert.match(source, /release ceiling is 20 minutes/);
  assert.doesNotMatch(source, /timeout-minutes:\s*(?:[2-9][0-9]|[1-9][0-9]{2,})/);
  assert.doesNotMatch(source, /wait_minutes=35|timeout-minutes:\s*55/);
  assert.match(source, /selection:[\s\S]*default: auto/);
  assert.match(source, /description: Recovery only - routine releases keep auto/);
  assert.match(source, /release-version --previous "\$previous" --sha "\$release_sha"/);
  assert.match(source, /release_sha="\$\{REQUESTED_SHA:-\$GITHUB_SHA\}"/);
  assert.match(source, /git merge-base --is-ancestor "\$release_sha" origin\/main/);
  assert.match(source, /unified-release\.mjs component-paths/);
  assert.match(source, /--component-paths "\$RUNNER_TEMP\/release-component-paths\.json"/);
  assert.match(source, /needs\.initialize\.outputs\.run_server == 'true'/);
  assert.match(source, /needs\.initialize\.outputs\.run_helper == 'true'/);
  assert.match(source, /needs\.initialize\.outputs\.run_mobile_ota == 'true'/);
  assert.match(source, /needs\.initialize\.outputs\.run_desktop == 'true'/);
  assert.match(source, /needs\.initialize\.outputs\.run_website == 'true'/);
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
  const checks = readFileSync(new URL('../.github/workflows/checks.yml', import.meta.url), 'utf8');
  const desktop = readFileSync(new URL('../.github/workflows/desktop.yml', import.meta.url), 'utf8');
  assert.match(release, /https:\/\/server\.usebeeline\.app\/readyz/);
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
