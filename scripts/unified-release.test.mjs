import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import {
  applyComponentCheckpoints,
  COMPONENT_PATH_RULES,
  RELEASE_BUDGET_MINUTES,
  RELEASE_COMPONENTS,
  finalizeRelease,
  initializeRelease,
  markComponentStage,
  releasePlanSummary,
  retryPlan,
  selectReleaseComponents,
} from './unified-release.mjs';

const OLD_SHA = '1'.repeat(40);
const NEW_SHA = '2'.repeat(40);

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

test('workflow is manual, selective, concurrent, bounded, and component-local on retry', () => {
  const source = readFileSync(new URL('../.github/workflows/unified-release.yml', import.meta.url), 'utf8');
  const workflow = parse(source);
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(workflow.jobs.initialize['timeout-minutes'], 2);
  assert.equal(workflow.jobs.release_result['timeout-minutes'], 2);
  assert.equal(RELEASE_BUDGET_MINUTES, 20);
  assert.match(source, /release ceiling is 20 minutes/);
  assert.doesNotMatch(source, /timeout-minutes:\s*(?:[2-9][0-9]|[1-9][0-9]{2,})/);
  assert.doesNotMatch(source, /wait_minutes=35|timeout-minutes:\s*55/);
  assert.match(source, /selection:[\s\S]*default: auto/);
  assert.match(source, /description: auto, all, or a comma-separated component list/);
  assert.match(source, /git diff --name-only "\$previous_sha" "\$release_sha"/);
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
});

test('production endpoint, stable downloads, rollback evidence, green gates, and final record remain wired', () => {
  const release = readFileSync(new URL('../.github/workflows/unified-release.yml', import.meta.url), 'utf8');
  const rollback = readFileSync(new URL('../.github/workflows/mobile-ota-rollback.yml', import.meta.url), 'utf8');
  const checks = readFileSync(new URL('../.github/workflows/checks.yml', import.meta.url), 'utf8');
  const desktop = readFileSync(new URL('../.github/workflows/desktop.yml', import.meta.url), 'utf8');
  assert.match(release, /https:\/\/server\.usebeeline\.app\/readyz/);
  assert.match(release, /unified-release-index/);
  assert.match(release, /store_track:/);
  assert.match(rollback, /mobile-ota-rollback-/);
  assert.match(desktop, /beeline-desktop-release-/);
  for (const gate of ['TYPECHECK', 'BODY SUITE', 'MOBILE SUITE', 'ACTIONLINT']) {
    assert.match(checks, new RegExp(`name: ${gate}$`, 'm'));
  }
});
