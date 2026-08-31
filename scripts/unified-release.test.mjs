import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  assertAllArtifactsBuilt,
  confirmPromotion,
  confirmRehearsal,
  deliveryReport,
  initializeRelease,
  markBuilt,
  nextReleaseVersion,
  supersedeRelease,
} from './unified-release.mjs';

const SHA_1 = '1'.repeat(40);
const SHA_2 = '2'.repeat(40);

function builtRelease() {
  const state = initializeRelease({ version: 'v0.0.1', sourceSha: SHA_1 });
  for (const component of ['server', 'daemon', 'app']) {
    markBuilt(state, component, { version: 'v0.0.1', sourceSha: SHA_1 });
  }
  assertAllArtifactsBuilt(state);
  return state;
}

test('human release semver starts at v0.0.1 and advances by patch', () => {
  assert.equal(nextReleaseVersion(undefined), 'v0.0.1');
  assert.equal(nextReleaseVersion('v0.0.1'), 'v0.0.2');
  assert.equal(nextReleaseVersion('v3.7.99'), 'v3.7.100');
});

test('the delivery gate refuses promotion until all same-sha artifacts are built', () => {
  const state = initializeRelease({ version: 'v0.0.1', sourceSha: SHA_1 });
  markBuilt(state, 'server', { version: 'v0.0.1', sourceSha: SHA_1 });
  markBuilt(state, 'daemon', { version: 'v0.0.1', sourceSha: SHA_1 });
  assert.throws(() => assertAllArtifactsBuilt(state), /app artifact is not built/);
  assert.throws(
    () => markBuilt(state, 'app', { version: 'v0.0.1', sourceSha: SHA_2 }),
    /does not match release/,
  );
});

test('promotion is enforced in server, daemon, app order', () => {
  const state = builtRelease();
  assert.throws(
    () => confirmPromotion(state, 'daemon', { version: 'v0.0.1', sourceSha: SHA_1 }),
    /before server confirms/,
  );
  confirmPromotion(state, 'server', { version: 'v0.0.1', sourceSha: SHA_1 });
  confirmPromotion(state, 'daemon', { version: 'v0.0.1', sourceSha: SHA_1 });
  confirmPromotion(state, 'app', { version: 'v0.0.1', sourceSha: SHA_1 });
  assert.equal(state.artifacts.app.state, 'confirmed');
});

test('a newer sha supersedes the whole release and freezes every old leg', () => {
  const state = builtRelease();
  supersedeRelease(state, { version: 'v0.0.2', sourceSha: SHA_2 });
  assert.equal(state.state, 'superseded');
  assert.deepEqual(state.supersededBy.version, 'v0.0.2');
  assert.throws(
    () => confirmPromotion(state, 'server', { version: 'v0.0.1', sourceSha: SHA_1 }),
    /was superseded/,
  );
});

test('delivery refuses mixed versions and requires aligned rehearsal proof', () => {
  const state = builtRelease();
  for (const component of ['server', 'daemon', 'app']) {
    confirmPromotion(state, component, { version: 'v0.0.1', sourceSha: SHA_1 });
  }
  assert.throws(() => deliveryReport(state), /not aligned and rehearsed/i);
  confirmRehearsal(state, { version: 'v0.0.1', sourceSha: SHA_1 });
  assert.throws(
    () =>
      deliveryReport(state, {
        server: { version: 'v0.0.1', sourceSha: SHA_1 },
        daemon: { version: 'v0.0.1', sourceSha: SHA_1 },
        app: { version: 'v0.0.2', sourceSha: SHA_2 },
      }),
    /NOT DELIVERED: mixed-version app/,
  );
  assert.equal(deliveryReport(state), `DELIVERED v0.0.1 (${SHA_1})`);
});

test('one workflow owns parallel builds, ordered promotion, retry, and the final report', () => {
  const workflow = readFileSync(new URL('../.github/workflows/unified-release.yml', import.meta.url), 'utf8');
  const mobile = readFileSync(new URL('../.github/workflows/mobile-ota.yml', import.meta.url), 'utf8');
  const daemon = readFileSync(new URL('../.github/workflows/beeline-bundle.yml', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../.github/workflows/deploy-host.yml', import.meta.url), 'utf8');

  assert.match(workflow, /group: unified-production-release\s+cancel-in-progress: true/);
  assert.match(workflow, /else\s+release_version=v0\.0\.1/);
  assert.match(workflow, /app_artifact:[\s\S]*daemon_artifact:[\s\S]*server_artifact:/);
  assert.match(workflow, /name: server-artifact-/);
  assert.match(workflow, /name: daemon-artifact-/);
  assert.match(workflow, /name: mobile-ota-candidate-/);
  assert.match(workflow, /artifact is \$\{identity\.version\}@\$\{identity\.sourceSha\}/);
  assert.ok(workflow.indexOf('promote_server:') < workflow.indexOf('promote_daemon:'));
  assert.ok(workflow.indexOf('promote_daemon:') < workflow.indexOf('promote_app:'));
  assert.ok(workflow.indexOf('promote_app:') < workflow.indexOf('post_promote_rehearsal:'));
  assert.match(workflow, /unified-release\.mjs report --state/);
  assert.match(workflow, /A newer main sha superseded this whole release/);
  for (const componentWorkflow of [mobile, daemon, server]) {
    assert.match(componentWorkflow, /workflow_call:/);
    assert.doesNotMatch(componentWorkflow, /push:\s*\n\s*branches:/);
  }
});
