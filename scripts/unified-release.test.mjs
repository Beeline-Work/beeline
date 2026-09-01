import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  assertAllArtifactsBuilt,
  assertDaemonFleetReady,
  confirmPromotion,
  confirmDelivery,
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

test('delivery refuses mixed versions and requires aligned ledger proof', () => {
  const state = builtRelease();
  for (const component of ['server', 'daemon', 'app']) {
    confirmPromotion(state, component, { version: 'v0.0.1', sourceSha: SHA_1 });
  }
  assert.throws(() => deliveryReport(state), /not aligned and ledger-confirmed/i);
  confirmDelivery(state, { version: 'v0.0.1', sourceSha: SHA_1 });
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

test('daemon fleet readiness identifies every agent that is not on the exact release', () => {
  assert.equal(
    assertDaemonFleetReady(
      {
        daemons: [
          {
            agentPubkey: 'a'.repeat(64),
            state: 'ready',
            releaseVersion: 'v0.0.1',
            sourceSha: SHA_1,
          },
        ],
      },
      'v0.0.1',
      SHA_1,
    ).length,
    1,
  );
  assert.throws(
    () =>
      assertDaemonFleetReady(
        {
          daemons: [
            {
              agentPubkey: 'b'.repeat(64),
              state: 'stale',
              releaseVersion: 'v0.0.0',
              sourceSha: SHA_2,
            },
          ],
        },
        'v0.0.1',
        SHA_1,
      ),
    new RegExp(`agent ${'b'.repeat(64)} reported stale v0.0.0@${SHA_2}`),
  );
});

test('one workflow owns parallel builds, ordered promotion, retry, and the final report', () => {
  const workflow = readFileSync(new URL('../.github/workflows/unified-release.yml', import.meta.url), 'utf8');
  const mobile = readFileSync(new URL('../.github/workflows/mobile-ota.yml', import.meta.url), 'utf8');
  const daemon = readFileSync(new URL('../.github/workflows/beeline-bundle.yml', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../.github/workflows/deploy-host.yml', import.meta.url), 'utf8');

  assert.match(workflow, /group: unified-production-release\s+cancel-in-progress: true/);
  assert.match(workflow, /else\s+release_version=v0\.0\.1/);
  assert.match(workflow, /app_artifact:[\s\S]*daemon_artifact:[\s\S]*server_artifact:/);
  assert.match(workflow, /retry_attempt:\s*\n\s*description: Governor-managed attempt number \(1-3\)\s*\n\s*type: string\s*\n\s*default: '1'/);
  assert.match(workflow, /app_artifact:[\s\S]*retry_attempt: \$\{\{ inputs\.retry_attempt \}\}/);
  assert.match(mobile, /retry_attempt:\s*\n\s*type: string\s*\n\s*default: '1'/);
  assert.match(workflow, /name: server-artifact-/);
  assert.match(workflow, /name: daemon-artifact-/);
  assert.match(workflow, /name: mobile-ota-candidate-/);
  assert.match(workflow, /artifact is \$\{identity\.version\}@\$\{identity\.sourceSha\}/);
  assert.ok(workflow.indexOf('promote_server:') < workflow.indexOf('promote_daemon:'));
  assert.ok(workflow.indexOf('promote_daemon:') < workflow.indexOf('promote_app:'));
  assert.ok(workflow.indexOf('promote_app:') < workflow.indexOf('delivery_report:'));
  assert.match(workflow, /unified-release\.mjs report --state/);
  assert.match(workflow, /unified-release\.mjs confirm-delivery --state/);
  assert.match(server, /flyctl auth whoami/);
  assert.match(server, /name: Deploy the exact release SHA to the monolith/);
  assert.match(server, /test "\$\(git rev-parse HEAD\)" = "\$RELEASE_SHA"/);
  assert.match(server, /flyctl deploy \. \\\n\s+--config fly\.beeline-server\.toml \\\n\s+--dockerfile apps\/server\/Dockerfile \\\n\s+--app beeline-server/);
  assert.match(server, /--build-arg "BEELINE_RELEASE_SHA=\$RELEASE_SHA"/);
  assert.doesNotMatch(server, /deploy-relay-host\.sh/);
  assert.match(workflow, /name: Confirm monolith readiness and exact deployed image/);
  assert.match(workflow, /https:\/\/server\.usebeeline\.app\/readyz/);
  assert.match(workflow, /https:\/\/server\.usebeeline\.app\/version/);
  assert.match(workflow, /deployed\.version !== version \|\| deployed\.sourceSha !== sourceSha/);
  assert.match(daemon, /https:\/\/server\.usebeeline\.app\/v1\/releases\/daemon-readiness/);
  assert.match(daemon, /unified-release\.mjs assert-daemons/);
  assert.doesNotMatch(daemon, /usebeeline\.app\/push\/health/);
  assert.match(workflow, /https:\/\/server\.usebeeline\.app\/v1\/releases\/daemon-readiness/);
  assert.doesNotMatch(workflow, /usebeeline\.app\/push\/health/);
  assert.doesNotMatch(workflow, /post_promote_rehearsal|mobile-ota-post-promote|emulator|Maestro/);
  assert.match(workflow, /A newer main sha superseded this whole release/);
  assert.doesNotMatch(workflow, /push:\s*\n\s*branches:/);
  assert.match(workflow, /^on:\s*\n\s*workflow_dispatch:/m);
  const promoteJob = mobile.slice(mobile.indexOf('\n  promote:'));
  assert.match(promoteJob, /cache-dependency-path: apps\/mobile\/package-lock\.json/);
  assert.match(promoteJob, /Install mobile dependencies for EAS project context[\s\S]*working-directory: apps\/mobile[\s\S]*run: npm ci/);
  assert.ok(
    promoteJob.indexOf('Install mobile dependencies for EAS project context') <
      promoteJob.indexOf('Promote the exact beta group to production'),
  );
  for (const componentWorkflow of [mobile, daemon, server]) {
    assert.match(componentWorkflow, /workflow_call:/);
    assert.doesNotMatch(componentWorkflow, /push:\s*\n\s*branches:/);
  }
  for (const [componentWorkflow, artifact] of [
    [server, 'server-artifact'],
    [daemon, 'daemon-artifact'],
    [mobile, 'mobile-ota-candidate'],
  ]) {
    assert.match(componentWorkflow, /Find a downloadable .* (artifact|candidate).*exact release SHA/);
    assert.match(componentWorkflow, new RegExp(`name = \`${artifact}-\\$\\{\\{ inputs\\.release_sha \\}\\}`));
    assert.match(componentWorkflow, /github\.rest\.actions\.listArtifactsForRepo/);
    assert.match(componentWorkflow, /github\.rest\.actions\.downloadArtifact/);
    assert.match(componentWorkflow, /actions\/download-artifact@v4/);
    assert.match(componentWorkflow, /run-id: \$\{\{ steps\.reuse\.outputs\.run_id \}\}/);
  }
  assert.match(mobile, /Reuse the exact mobile candidate, including its delivery sidecars/);
  assert.match(mobile, /path: \$\{\{ runner\.temp \}\}/);
});
