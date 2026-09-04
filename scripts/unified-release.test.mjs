import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

test('report subcommand requires and accepts the exact release identity', () => {
  const directory = mkdtempSync(join(tmpdir(), 'unified-release-report-'));
  const commandPath = fileURLToPath(new URL('./unified-release.mjs', import.meta.url));
  try {
    const state = builtRelease();
    for (const component of ['server', 'daemon', 'app']) {
      confirmPromotion(state, component, { version: 'v0.0.1', sourceSha: SHA_1 });
    }
    confirmDelivery(state, { version: 'v0.0.1', sourceSha: SHA_1 });
    const statePath = join(directory, 'state.json');
    const observedPath = join(directory, 'observed.json');
    writeFileSync(statePath, JSON.stringify(state));
    writeFileSync(
      observedPath,
      JSON.stringify(
        Object.fromEntries(
          ['server', 'daemon', 'app'].map((component) => [
            component,
            { version: 'v0.0.1', sourceSha: SHA_1 },
          ]),
        ),
      ),
    );

    const report = spawnSync(
      process.execPath,
      [
        commandPath,
        'report',
        '--state',
        statePath,
        '--observed',
        observedPath,
        '--version',
        'v0.0.1',
        '--sha',
        SHA_1,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(report.status, 0, report.stderr);
    assert.equal(report.stdout.trim(), `DELIVERED v0.0.1 (${SHA_1})`);

    const missingIdentity = spawnSync(
      process.execPath,
      [commandPath, 'report', '--state', statePath],
      { encoding: 'utf8' },
    );
    assert.equal(missingIdentity.status, 1);
    assert.match(missingIdentity.stderr, /invalid release version: <missing>/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a never-reported ghost agent does not block the release confirm, a silent one does', () => {
  const ghost = 'd'.repeat(64);
  assert.equal(
    assertDaemonFleetReady(
      {
        daemons: [
          {
            agentPubkey: 'a'.repeat(64),
            state: 'ready',
            version: 'v0.0.1',
            sha: SHA_1,
          },
          { agentPubkey: ghost, state: 'never-seen' },
        ],
        summary: { total: 2, ready: 1, neverSeen: 1 },
      },
      'v0.0.1',
      SHA_1,
    ).length,
    2,
  );
  assert.throws(
    () =>
      assertDaemonFleetReady(
        {
          daemons: [
            { agentPubkey: 'a'.repeat(64), state: 'ready', version: 'v0.0.1', sha: SHA_1 },
            { agentPubkey: 'e'.repeat(64), state: 'missing' },
          ],
          summary: { total: 2, ready: 1, neverSeen: 0 },
        },
        'v0.0.1',
        SHA_1,
      ),
    (error) => {
      assert.match(error.message, new RegExp(`agent ${'e'.repeat(64)} reported missing`));
      return true;
    },
  );
  assert.throws(
    () =>
      assertDaemonFleetReady(
        { daemons: [{ agentPubkey: ghost, state: 'never-seen' }] },
        'v0.0.1',
        SHA_1,
      ),
    /no agents that ever reported/,
  );
});

test('daemon fleet readiness identifies every agent that is not on the exact release', () => {
  assert.equal(
    assertDaemonFleetReady(
      {
        daemons: [
          {
            agentPubkey: 'a'.repeat(64),
            state: 'ready',
            version: 'v0.0.1',
            sha: SHA_1,
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
              version: 'v0.0.0',
              sha: SHA_2,
            },
            {
              agentPubkey: 'c'.repeat(64),
              state: 'ready',
            },
          ],
        },
        'v0.0.1',
        SHA_1,
      ),
    (error) => {
      assert.match(
        error.message,
        new RegExp(`agent ${'b'.repeat(64)} reported stale v0.0.0@${SHA_2}`),
      );
      assert.match(
        error.message,
        new RegExp(`agent ${'c'.repeat(64)} reported ready <missing-version>@<missing-sha>`),
      );
      assert.match(error.message, new RegExp(`expected ready v0.0.1@${SHA_1}`));
      return true;
    },
  );
});

test('one workflow owns parallel builds, ordered promotion, retry, and the final report', () => {
  const workflow = readFileSync(new URL('../.github/workflows/unified-release.yml', import.meta.url), 'utf8');
  // The three release legs are composite actions, each called twice by the
  // workflow above (build, then promote).
  const mobile = readFileSync(new URL('../.github/actions/mobile-ota-leg/action.yml', import.meta.url), 'utf8');
  const daemon = readFileSync(new URL('../.github/actions/daemon-leg/action.yml', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../.github/actions/server-leg/action.yml', import.meta.url), 'utf8');

  assert.match(workflow, /group: unified-production-release\s+cancel-in-progress: true/);
  assert.match(workflow, /else\s+release_version=v0\.0\.1/);
  assert.match(workflow, /app_artifact:[\s\S]*daemon_artifact:[\s\S]*server_artifact:/);
  assert.match(workflow, /retry_attempt:\s*\n\s*description: Governor-managed attempt number \(1-3\)\s*\n\s*type: string\s*\n\s*default: '1'/);
  assert.match(workflow, /app_artifact:[\s\S]*retry_attempt: \$\{\{ inputs\.retry_attempt \}\}/);
  assert.match(mobile, /retry_attempt:\s*\n\s*default: '1'/);
  assert.match(workflow, /name: server-artifact-/);
  assert.match(workflow, /name: daemon-artifact-/);
  assert.match(workflow, /name: mobile-ota-candidate-/);
  assert.match(workflow, /artifact is \$\{identity\.version\}@\$\{identity\.sourceSha\}/);
  assert.ok(workflow.indexOf('promote_server:') < workflow.indexOf('promote_daemon:'));
  assert.ok(workflow.indexOf('promote_daemon:') < workflow.indexOf('promote_app:'));
  assert.ok(workflow.indexOf('promote_app:') < workflow.indexOf('delivery_report:'));
  assert.match(
    workflow,
    /unified-release\.mjs report --state[\s\S]*?--version "\$RELEASE_VERSION"[\s\S]*?--sha "\$RELEASE_SHA"/,
  );
  assert.match(workflow, /unified-release\.mjs confirm-delivery --state/);
  assert.match(workflow, /daemon: \{ version: daemon\.version, sourceSha: daemon\.sha \}/);
  // Each leg is invoked exactly twice: one build call and one promote call.
  for (const [action, phases] of [
    ['./.github/actions/server-leg', ['build', 'promote']],
    ['./.github/actions/daemon-leg', ['build', 'promote']],
    ['./.github/actions/mobile-ota-leg', ['build', 'promote']],
  ]) {
    const calls = workflow.split(`uses: ${action}\n`).slice(1);
    assert.equal(calls.length, 2, `${action} must be called exactly twice`);
    assert.deepEqual(
      calls.map((call) => call.match(/phase: (\w+)/)[1]),
      phases,
    );
  }
  const retryJob = workflow.slice(workflow.indexOf('\n  retry:'));
  for (const job of [
    'promote_server',
    'confirm_server',
    'promote_daemon',
    'confirm_daemon',
    'promote_app',
    'confirm_app',
  ]) {
    assert.match(retryJob, new RegExp(`needs\\.${job}\\.result == 'success'`));
  }
  assert.doesNotMatch(retryJob, /needs\.delivery_report\.result\s*!=\s*'success'/);
  // The retry re-dispatches THIS workflow with the same identity, carrying
  // the store choice so a retried release does not silently drop it.
  assert.match(retryJob, /workflow_id: 'unified-release\.yml'/);
  assert.match(retryJob, /store_track: process\.env\.STORE_TRACK/);
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
  // A busy helper may hold its restart for the whole drain deadline, so the
  // confirm waits 35 minutes and prints one readiness table per minute.
  assert.match(daemon, /wait_minutes=35/);
  assert.match(daemon, /readiness_table/);
  assert.match(workflow, /promote_daemon:[\s\S]*?timeout-minutes: 40/);
  assert.match(daemon, /cat "\$RUNNER_TEMP\/release-readiness-error\.txt" >&2/);
  assert.doesNotMatch(daemon, /usebeeline\.app\/push\/health/);
  assert.match(workflow, /https:\/\/server\.usebeeline\.app\/v1\/releases\/daemon-readiness/);
  assert.doesNotMatch(workflow, /usebeeline\.app\/push\/health/);
  assert.doesNotMatch(workflow, /post_promote_rehearsal|mobile-ota-post-promote|emulator|Maestro/);
  assert.match(workflow, /A newer main sha superseded this whole release/);
  assert.doesNotMatch(workflow, /push:\s*\n\s*branches:/);
  assert.match(workflow, /^on:\s*\n\s*workflow_dispatch:/m);
  const promoteSteps = mobile.slice(mobile.indexOf('# ---- promote'));
  assert.match(promoteSteps, /cache-dependency-path: apps\/mobile\/package-lock\.json/);
  assert.match(promoteSteps, /Install mobile dependencies for EAS project context[\s\S]*working-directory: apps\/mobile[\s\S]*run: npm ci/);
  assert.ok(
    promoteSteps.indexOf('Install mobile dependencies for EAS project context') <
      promoteSteps.indexOf('Promote the exact beta group to production'),
  );
  for (const leg of [mobile, daemon, server]) {
    assert.match(leg, /using: composite/);
    assert.doesNotMatch(leg, /push:\s*\n\s*branches:/);
  }
  for (const [leg, artifact] of [
    [server, 'server-artifact'],
    [daemon, 'daemon-artifact'],
    [mobile, 'mobile-ota-candidate'],
  ]) {
    assert.match(leg, /Find a downloadable .* (artifact|candidate).*exact release SHA/);
    assert.match(
      leg,
      new RegExp(`name = \\\`${artifact}-\\$\\{\\{ inputs\\.release_sha \\}\\}`),
    );
    assert.match(leg, /github\.rest\.actions\.listArtifactsForRepo/);
    assert.match(leg, /github\.rest\.actions\.downloadArtifact/);
    assert.match(leg, /actions\/download-artifact@v4/);
    assert.match(leg, /run-id: \$\{\{ steps\.reuse\.outputs\.run_id \}\}/);
  }
  assert.match(mobile, /Reuse the exact mobile candidate, including its delivery sidecars/);
  assert.match(mobile, /path: \$\{\{ runner\.temp \}\}/);
});

test('the release publishes usebeeline to npm as its own final job, gated on delivery', () => {
  const workflow = readFileSync(new URL('../.github/workflows/unified-release.yml', import.meta.url), 'utf8');
  const npmJob = workflow.slice(workflow.indexOf('\n  npm_publish:'));
  // Gated on the delivery report, not on a workflow_run of a separate file.
  assert.match(npmJob, /needs: \[initialize, delivery_report\]/);
  assert.match(npmJob, /id-token: write/);
  assert.match(npmJob, /npm publish --no-provenance --workspace usebeeline/);
  // The version is the delivered release index's version, for the exact SHA.
  assert.match(npmJob, /unified-release-index/);
  assert.match(npmJob, /r\.sourceSha!==process\.argv\[2\]/);
  assert.doesNotMatch(workflow, /workflow_run:/);
});

test('the store leg runs only on request, from the release sha, and never un-delivers a release', () => {
  const workflow = readFileSync(new URL('../.github/workflows/unified-release.yml', import.meta.url), 'utf8');
  assert.match(
    workflow,
    /store_track:[\s\S]*?type: choice[\s\S]*?default: none[\s\S]*?- none[\s\S]*?- internal[\s\S]*?- beta[\s\S]*?- production/,
  );
  const android = workflow.slice(workflow.indexOf('\n  store_android:'), workflow.indexOf('\n  store_ios:'));
  const ios = workflow.slice(workflow.indexOf('\n  store_ios:'), workflow.indexOf('\n  not_delivered:'));
  for (const job of [android, ios]) {
    assert.match(job, /needs: \[initialize, confirm_app\]/);
    assert.match(
      job,
      /if: contains\(fromJSON\('\["internal","beta","production"\]'\), inputs\.store_track\)/,
    );
    // Both store binaries are built from the exact release SHA.
    assert.match(job, /ref: \$\{\{ needs\.initialize\.outputs\.release_sha \}\}/);
    assert.match(job, /The release itself is judged by the delivery report, not by this job\./);
  }
  assert.match(android, /build --profile production --platform android/);
  assert.match(android, /RELEASE_STATUS: draft/);
  assert.match(android, /run: bash scripts\/play-publish\.sh/);
  assert.match(android, /run: bash scripts\/play-publish-listing\.sh/);
  assert.match(android, /run: node scripts\/play-token\.mjs/);
  assert.match(android, /TRACK: \$\{\{ inputs\.store_track \}\}/);
  assert.match(ios, /build --profile production-ci --platform ios/);
  assert.match(ios, /submit --platform ios --profile production/);
  // The ASC key must be written before the build: eas-cli needs it to create
  // or repair the provisioning profile non-interactively.
  assert.ok(
    ios.indexOf('Write the App Store Connect API key') <
      ios.indexOf('Build the iOS app on EAS from the release SHA'),
  );
  // Nothing depends on the store jobs, so a store failure cannot fail the
  // release: delivery_report and not_delivered never name them.
  const deliveryJob = workflow.slice(workflow.indexOf('\n  delivery_report:'), workflow.indexOf('\n  npm_publish:'));
  assert.doesNotMatch(deliveryJob, /store_android|store_ios/);
  const retryJob = workflow.slice(workflow.indexOf('\n  retry:'));
  assert.doesNotMatch(retryJob, /needs\.store_android|needs\.store_ios/);
});

test('the five PR gates live in one file under their unchanged check names', () => {
  const checks = readFileSync(new URL('../.github/workflows/checks.yml', import.meta.url), 'utf8');
  for (const name of [
    'TYPECHECK',
    'BODY SUITE',
    'MOBILE SUITE',
    'MOBILE-EXPORT REACHABILITY',
    'PRODUCTION-CORPUS REPLAY',
    'FRAME-BUDGET',
    'STATE-UPGRADE',
    'ACTIONLINT',
    'Build auth container',
    'Detect changes',
  ]) {
    assert.match(checks, new RegExp(`name: ${name}$`, 'm'), `check name ${name} must not change`);
  }
  assert.match(checks, /^on:\s*\n\s*pull_request: \{\}/m);
  // TYPECHECK alone has no path filter (two green PRs can merge into a red main).
  const typecheckJob = checks.slice(checks.indexOf('\n  typecheck:'), checks.indexOf('\n  body-suite:'));
  assert.doesNotMatch(typecheckJob, /needs: changes/);
  assert.match(typecheckJob, /npx turbo run typecheck/);
  // Every other gate keeps a path filter through the one changes job.
  for (const output of [
    'body',
    'mobileSuite',
    'mobileExportReachability',
    'productionCorpusReplay',
    'frameBudget',
    'stateUpgrade',
    'workflows',
    'authImage',
  ]) {
    assert.match(checks, new RegExp(`${output}: \\$\\{\\{ steps\\.filter\\.outputs\\.${output} \\}\\}`));
  }
  assert.match(checks, /'\.github\/actions\/\*\*'/);
});
