import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import {
  assignReleaseVersion,
  latestPublished,
  migrationRecord,
  otaRollbackTarget,
  serverRollbackImage,
  staleDrafts,
} from './release-record.mjs';
import {
  applyComponentCheckpoints,
  applyJobFacts,
  checkpointsFromJobs,
  finalizeRelease,
  initializeRelease,
  otaMemory,
  planServerCanaryDeployment,
} from './unified-release.mjs';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
let clock = 0;
const release = (tag, { draft = false, prerelease = false, sha = A, published = !draft } = {}) => ({
  tag_name: tag, draft, prerelease, target_commitish: sha, assets: [],
  published_at: published ? new Date(Date.UTC(2026, 9, 1) + (clock += 60_000)).toISOString() : null,
});

test('the most recently published vX.Y.Z release is the previous release; drafts and channels are not', () => {
  const releases = [
    // The retired August line has higher version numbers than today's line.
    release('v0.2.17', { sha: C }),
    release('helper-update-channel', { prerelease: true }),
    release('v0.1.121', { sha: A }),
    release('v0.1.122', { sha: B }),
    release('v0.1.123', { draft: true, sha: C }),
  ];
  assert.equal(latestPublished(releases).tag_name, 'v0.1.122');
  // The next identity continues today's line, skipping the reserved draft.
  assert.equal(assignReleaseVersion({ releases, previous: { version: 'v0.1.122', sourceSha: B }, sha: A }).version, 'v0.1.124');
});

// Reproduction IDENTITY-GUARD (runs 38954447489, 38954826177): a leftover
// draft v0.1.71 for 552ef289 blocked the next dispatch of 24c48a76 with
// "draft v0.1.71 targets SHA 552ef289..., not the release SHA 24c48a76".
test('IDENTITY-GUARD: a draft for another commit never blocks the next dispatch', () => {
  const previous = { version: 'v0.1.70', sourceSha: A };
  const releases = [release('v0.1.70', { sha: A }), release('v0.1.71', { draft: true, sha: B })];
  // Routine dispatch: the abandoned draft's version is skipped.
  assert.deepEqual(assignReleaseVersion({ releases, previous, sha: C }), { version: 'v0.1.72', reason: 'next' });
  // Recovery that names the abandoned draft's version for another commit.
  assert.deepEqual(assignReleaseVersion({ releases, previous, sha: C, requestedVersion: 'v0.1.71' }), { version: 'v0.1.72', reason: 'next' });
  // A published identity of another commit is still refused.
  assert.throws(() => assignReleaseVersion({ releases, previous, sha: C, requestedVersion: 'v0.1.70' }), /published release/);
});

test('a rerun of the same commit resumes its draft identity, so every leg sees what already shipped', () => {
  const previous = { version: 'v0.1.70', sourceSha: A };
  const releases = [release('v0.1.70', { sha: A }), release('v0.1.71', { draft: true, sha: B })];
  assert.deepEqual(assignReleaseVersion({ releases, previous, sha: B }), { version: 'v0.1.71', reason: 'resume-draft' });
  assert.deepEqual(assignReleaseVersion({ releases, previous, sha: B, requestedVersion: 'v0.1.71' }), { version: 'v0.1.71', reason: 'existing-identity' });
  // The newest published commit is a no-op identity.
  assert.deepEqual(assignReleaseVersion({ releases, previous, sha: A }), { version: 'v0.1.70', reason: 'already-published' });
  // A stale draft below the newest published release is never resumed.
  const stale = [release('v0.1.70', { sha: A }), release('v0.1.69', { draft: true, sha: B })];
  assert.equal(assignReleaseVersion({ releases: stale, previous, sha: B }).version, 'v0.1.71');
  assert.deepEqual(staleDrafts([...releases, release('v0.1.60', { draft: true, sha: C })], 'v0.1.71').map((r) => r.tag_name), ['v0.1.60']);
});

test('a release published before release.json migrates with production as its OTA branch', () => {
  const record = migrationRecord({ version: 'v0.2.30', sourceSha: A, desktopVersion: '0.1.40' });
  assert.equal(record.components['mobile-ota'].otaBranch, 'production');
  assert.equal(record.components.desktop.desktopVersion, '0.1.40');
  assert.ok(Object.values(record.components).every((entry) => entry.sourceSha === A && entry.state === 'carried'));
  // The first new release plans from it and carries the legacy branch fact.
  const next = initializeRelease({ version: 'v0.2.31', sourceSha: B, previous: record, selectedComponents: ['server'] });
  assert.equal(next.components['mobile-ota'].otaBranch, 'production');
  assert.equal(next.components.desktop.desktopVersion, '0.1.40');
  assert.equal(otaMemory(record).previousBranch, 'production');
});

function shipped({ version, sha, previous, needs, selected }) {
  const state = initializeRelease({ version, sourceSha: sha, previous, selectedComponents: selected });
  const identity = { version, sourceSha: sha, releaseId: `${version}-${sha}` };
  const outputs = Object.fromEntries(['server', 'helper', 'mobile_ota', 'mobile_native', 'desktop', 'website']
    .map((name) => [`run_${name}`, String(selected.includes(name.replace('_', '-')))]));
  const allNeeds = { initialize: { result: 'success', outputs }, ...needs };
  applyComponentCheckpoints(state, checkpointsFromJobs(allNeeds, identity));
  applyJobFacts(state, allNeeds, { previous, runtimePins: { android: '43', ios: '36' } });
  return finalizeRelease(state);
}

test('the release record keeps the server image and OTA branch, and carries them when a leg does not run', () => {
  const v30 = migrationRecord({ version: 'v0.2.30', sourceSha: A, desktopVersion: '0.1.40' });
  const v31 = shipped({ version: 'v0.2.31', sha: B, previous: v30, selected: ['server', 'mobile-ota'], needs: {
    server: { result: 'success', outputs: { image_ref: 'registry.fly.io/beeline-server:0.2.31-bbbbbbbbbbbb', previous_image_ref: 'registry.fly.io/beeline-server:0.2.30-aaaaaaaaaaaa' } },
    mobile_ota: { result: 'success', outputs: { ota_branch: 'release-v0.2.31', ota_targets: 'android@40,android@39,ios@36', store_runtime: '{"previouslyLive":[{"platform":"android","runtimeVersion":"39"}]}' } },
  } });
  assert.equal(v31.components.server.imageRef, 'registry.fly.io/beeline-server:0.2.31-bbbbbbbbbbbb');
  assert.equal(v31.components.server.previousImageRef, 'registry.fly.io/beeline-server:0.2.30-aaaaaaaaaaaa');
  assert.equal(v31.components['mobile-ota'].otaBranch, 'release-v0.2.31');
  assert.equal(v31.components['mobile-ota'].previousOtaBranch, 'production');
  assert.deepEqual(v31.components['mobile-ota'].otaTargets, ['android@40', 'android@39', 'ios@36']);
  assert.deepEqual(otaMemory(v31).previousTargets.map((t) => t.runtimeVersion), ['40', '39', '36']);
  // v0.2.32 ships only the website: server and OTA facts are carried.
  const v32 = shipped({ version: 'v0.2.32', sha: C, previous: v31, selected: ['website'], needs: {
    website: { result: 'success', outputs: {} },
  } });
  assert.equal(v32.components.server.imageRef, v31.components.server.imageRef);
  assert.equal(v32.components.server.previousImageRef, v31.components.server.previousImageRef);
  assert.equal(v32.components['mobile-ota'].otaBranch, 'release-v0.2.31');
  assert.equal(v32.components['mobile-ota'].previousOtaBranch, 'production');
  // A store upload's build number becomes a known runtime identity.
  const v33 = shipped({ version: 'v0.2.33', sha: A, previous: v32, selected: ['mobile-native'], needs: {
    mobile_native_android: { result: 'success', outputs: { version_code: '141' } },
    mobile_native_ios: { result: 'skipped', outputs: {} },
  } });
  assert.deepEqual(v33.storeRuntime.builds.map((b) => `${b.platform}:${b.buildNumber}@${b.runtimeVersion}`), ['android:141@43']);
});

test('a server rerun that found its image already live keeps the image it replaced from the record', () => {
  const v30 = migrationRecord({ version: 'v0.2.30', sourceSha: A });
  v30.components.server.imageRef = 'registry.fly.io/beeline-server:0.2.30-aaaaaaaaaaaa';
  const v31 = shipped({ version: 'v0.2.31', sha: B, previous: v30, selected: ['server'], needs: {
    server: { result: 'success', outputs: { image_ref: 'registry.fly.io/beeline-server:0.2.31-bbbbbbbbbbbb', previous_image_ref: '' } },
  } });
  assert.equal(v31.components.server.previousImageRef, 'registry.fly.io/beeline-server:0.2.30-aaaaaaaaaaaa');
});

const image = (version, sha) => `registry.fly.io/beeline-server:${version.slice(1)}-${sha.slice(0, 12)}`;
const digest = (ref) => `${ref}@sha256:${'0'.repeat(64)}`;

// The server leg's "Ask Fly whether this release already runs" script, run
// exactly as the action runs it against a `flyctl machine list --json` file.
function askFly(machines, target) {
  const action = parse(readFileSync(new URL('../.github/actions/server-leg/action.yml', import.meta.url), 'utf8'));
  const step = action.runs.steps.find((candidate) => candidate.id === 'fleet');
  const script = /<<'NODE'\n([\s\S]*?)\nNODE/.exec(step.run)[1];
  const root = mkdtempSync(join(tmpdir(), 'beeline-fleet-'));
  try {
    const file = join(root, 'machines.json');
    writeFileSync(file, JSON.stringify(machines));
    const out = execFileSync('node', ['-', file, target], { input: script, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    return Object.fromEntries(out.trim().split('\n').map((line) => line.split(/=(.*)/s).slice(0, 2)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('server rollback returns to the previous published release, not an attempt that deployed and then failed', () => {
  const v30 = migrationRecord({ version: 'v0.2.30', sourceSha: 'd'.repeat(40) });
  const v31 = shipped({ version: 'v0.2.31', sha: A, previous: v30, selected: ['server'], needs: {
    server: { result: 'success', outputs: { image_ref: image('v0.2.31', A), previous_image_ref: image('v0.2.29', C) } },
  } });
  // v0.2.32 deployed its image and failed in another leg: it never published.
  // v0.2.33 replaces that image on the fleet and publishes.
  const v33 = shipped({ version: 'v0.2.33', sha: C, previous: v31, selected: ['server'], needs: {
    server: { result: 'success', outputs: { image_ref: image('v0.2.33', C), previous_image_ref: image('v0.2.32', B) } },
  } });
  assert.equal(v33.components.server.previousImageRef, image('v0.2.31', A));
  const live = image('v0.2.33', C);
  assert.equal(serverRollbackImage({ record: v33, machineImages: [digest(live), digest(live)] }).image, image('v0.2.31', A));
});

test('a rerun of the first migrated release reads the replaced image from the Machines, so rollback still has a target', () => {
  const legacy = image('v0.2.30', A);
  const target = image('v0.2.31', B);
  // First attempt: the fleet still runs the legacy image.
  assert.equal(askFly([{ id: 'm1', config: { image: digest(legacy) } }, { id: 'm2', config: { image: digest(legacy) } }], target)
    .previous_image_ref, legacy);
  // The attempt updated both Machines, recording the replaced image, then
  // failed elsewhere. The rerun finds the release live.
  const updated = (id) => ({ id, config: { image: digest(target), metadata: { fly_process_group: 'app', beeline_replaced_image: legacy } } });
  const rerun = askFly([updated('m1'), updated('m2')], target);
  assert.equal(rerun.shipped, 'true');
  assert.equal(rerun.previous_image_ref, legacy);
  const v31 = shipped({ version: 'v0.2.31', sha: B, previous: migrationRecord({ version: 'v0.2.30', sourceSha: A }), selected: ['server'], needs: {
    server: { result: 'success', outputs: { image_ref: rerun.image_ref, previous_image_ref: rerun.previous_image_ref } },
  } });
  assert.equal(v31.components.server.previousImageRef, legacy);
  assert.equal(serverRollbackImage({ record: v31, machineImages: [digest(target), digest(target)] }).image, legacy);
  // A split fleet names the image its unfinished Machine still runs.
  assert.equal(askFly([updated('m1'), { id: 'm2', config: { image: digest(image('v0.2.29', C)) } }], target).previous_image_ref, image('v0.2.29', C));
});

// Rollback stories: return to the previous release, even if the newest run
// failed in an unrelated step after shipping its own leg.
test('phone rollback returns to the release before the live one, or to the newest published release', () => {
  const record = { version: 'v0.2.31', components: { 'mobile-ota': { otaBranch: 'release-v0.2.31', previousOtaBranch: 'release-v0.2.30' } } };
  assert.equal(otaRollbackTarget({ record, currentBranch: 'release-v0.2.31' }).branch, 'release-v0.2.30');
  // v0.2.32 promoted its branch and then failed in desktop: back to v0.2.31.
  assert.equal(otaRollbackTarget({ record, currentBranch: 'release-v0.2.32' }).branch, 'release-v0.2.31');
  // Rolling back twice does not roll forward.
  assert.equal(otaRollbackTarget({ record, currentBranch: 'release-v0.2.30' }).noop, true);
  assert.equal(otaRollbackTarget({ record, currentBranch: 'release-v0.2.31', explicitBranch: 'release-v0.2.20' }).branch, 'release-v0.2.20');
  // The first release on the new scheme rolls back to the legacy branch.
  const first = { version: 'v0.2.31', components: { 'mobile-ota': { otaBranch: 'release-v0.2.31', previousOtaBranch: 'production' } } };
  assert.equal(otaRollbackTarget({ record: first, currentBranch: 'release-v0.2.31' }).branch, 'production');
});

test('server rollback returns to the image before the live release and finishes a split fleet', () => {
  const record = { version: 'v0.2.31', components: { server: {
    imageRef: 'registry.fly.io/beeline-server:0.2.31-bbbbbbbbbbbb',
    previousImageRef: 'registry.fly.io/beeline-server:0.2.30-aaaaaaaaaaaa',
  } } };
  const machines = (...images) => images.map((image) => `${image}@sha256:${'0'.repeat(64)}`);
  assert.equal(serverRollbackImage({ record, machineImages: machines(record.components.server.imageRef, record.components.server.imageRef) }).image,
    'registry.fly.io/beeline-server:0.2.30-aaaaaaaaaaaa');
  const failedLater = 'registry.fly.io/beeline-server:0.2.32-cccccccccccc';
  assert.equal(serverRollbackImage({ record, machineImages: machines(failedLater, failedLater) }).image, record.components.server.imageRef);
  assert.match(serverRollbackImage({ record, machineImages: machines(failedLater, record.components.server.imageRef) }).reason, /split/);
  assert.equal(serverRollbackImage({ record, machineImages: machines(record.components.server.previousImageRef, record.components.server.previousImageRef) }).noop, true);
  assert.throws(() => serverRollbackImage({ record: migrationRecord({ version: 'v0.2.30', sourceSha: A }), machineImages: [] }), /image_ref explicitly/);
});

// Reproduction SERVER-SPLIT (runs 39715148594, 39623952933): the server leg
// stopped with "server fleet is already split across images; refuse an
// ambiguous rollback".
test('SERVER-SPLIT: a fleet left on two images is finished on the release image', () => {
  const plan = planServerCanaryDeployment([
    { id: 'm2', config: { image: 'registry.fly.io/beeline-server:0.2.31-bbbbbbbbbbbb' } },
    { id: 'm1', config: { image: 'registry.fly.io/beeline-server:0.2.30-aaaaaaaaaaaa' } },
  ], 'registry.fly.io/beeline-server:0.2.32-cccccccccccc');
  assert.equal(plan.split, true);
  assert.deepEqual(plan.steps, [
    'migrate',
    'update:m1:registry.fly.io/beeline-server:0.2.32-cccccccccccc',
    'watch:m1:90s',
    'update:m2:registry.fly.io/beeline-server:0.2.32-cccccccccccc',
  ]);
  // Each Machine returns to its own previous image if the canary fails.
  assert.deepEqual(plan.rollbackSteps, [
    'update:m1:registry.fly.io/beeline-server:0.2.30-aaaaaaaaaaaa',
    'update:m2:registry.fly.io/beeline-server:0.2.31-bbbbbbbbbbbb',
    'fail-release',
  ]);
});
