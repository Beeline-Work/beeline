#!/usr/bin/env node
// The release pipeline's only memory is the permanent GitHub Release.
//
// Each published release carries one small `release.json` asset, written once
// when the release is published: per-component source commits, the server
// image, the phone OTA branch, the desktop updater counter and the store
// builds this pipeline uploaded. The next release reads the newest published
// release; rollbacks read it to find where to return. No Actions artifact,
// cache or run lookup carries state between jobs or runs.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASE_RECORD_ASSET = 'release.json';
export const LEGACY_OTA_BRANCH = 'production';
const COMPONENTS = ['server', 'helper', 'mobile-ota', 'mobile-native', 'desktop', 'website'];
const VERSION = /^v(\d+)\.(\d+)\.(\d+)$/;
const SHA = /^[0-9a-f]{40}$/;

function fail(message) {
  throw new Error(message);
}

export function compareVersions(left, right) {
  const a = VERSION.exec(left);
  const b = VERSION.exec(right);
  if (!a || !b) fail(`cannot compare release versions ${left} and ${right}`);
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference) return difference;
  }
  return 0;
}

/** Releases named vX.Y.Z, newest version first. Rolling channels are ignored. */
export function versionedReleases(releases) {
  return releases
    .filter((release) => VERSION.test(release.tag_name ?? ''))
    .sort((left, right) => compareVersions(right.tag_name, left.tag_name));
}

/**
 * Published vX.Y.Z releases, most recently published first. Publication
 * order, not version order: the repository also holds an older v0.2.x line
 * from August that the current v0.1.x line must not be compared against.
 */
export function publishedReleases(releases) {
  return releases
    .filter((release) => VERSION.test(release.tag_name ?? '') && !release.draft && !release.prerelease)
    .sort((left, right) => String(right.published_at ?? '').localeCompare(String(left.published_at ?? '')));
}

export function latestPublished(releases) {
  return publishedReleases(releases)[0] ?? null;
}

/**
 * A record for a release published before release.json existed. Every
 * component is treated as shipped at that release's commit; the phone OTA was
 * served from the fixed `production` branch.
 */
export function migrationRecord({ version, sourceSha, desktopVersion }) {
  if (!VERSION.test(version ?? '')) fail(`invalid migrated release version: ${version}`);
  if (!SHA.test(sourceSha ?? '')) fail(`invalid migrated release sha: ${sourceSha}`);
  const components = Object.fromEntries(COMPONENTS.map((component) => [component, {
    state: 'carried', selected: false, version, sourceSha,
    artifactRef: `${component}-${version}-${sourceSha}`,
    ...(component === 'desktop' && desktopVersion ? { desktopVersion } : {}),
    ...(component === 'mobile-ota' ? { otaBranch: LEGACY_OTA_BRANCH } : {}),
  }]));
  return {
    schemaVersion: 2, version, sourceSha, state: 'delivered', migrated: true,
    plan: { selected: [], carried: [...COMPONENTS] },
    components, delivery: { state: 'success' },
  };
}

/**
 * The identity for this dispatch, decided from GitHub Releases alone.
 *
 * - The newest published release already at this commit is a no-op.
 * - A draft at this commit (an earlier attempt of the same source) is reused,
 *   so every leg can see what that attempt already shipped.
 * - Otherwise the next free version. Drafts for other commits never block:
 *   their versions are skipped.
 * - An explicit recovery version is honoured when free or held by this
 *   commit; a published release of another commit refuses it, and an
 *   abandoned draft of another commit is passed over for a fresh version.
 */
export function assignReleaseVersion({ releases, previous, sha, requestedVersion = '' }) {
  if (!SHA.test(sha ?? '')) fail(`invalid release sha: ${sha}`);
  const versioned = versionedReleases(releases);
  const reserved = new Set(versioned.map((release) => release.tag_name));
  const commitOf = (release) => release.sourceSha ?? (SHA.test(release.target_commitish ?? '') ? release.target_commitish : null);
  if (requestedVersion) {
    if (!VERSION.test(requestedVersion)) fail(`invalid requested release version: ${requestedVersion}`);
    const existing = versioned.find((release) => release.tag_name === requestedVersion);
    if (!existing || commitOf(existing) === sha) return { version: requestedVersion, reason: existing ? 'existing-identity' : 'requested' };
    if (!existing.draft) {
      fail(`${requestedVersion} is a published release of ${commitOf(existing) ?? 'another commit'}, not ${sha}; dispatch without release_version for a fresh identity`);
    }
    console.error(`::warning::${requestedVersion} is an abandoned draft of ${commitOf(existing) ?? 'another commit'}; assigning a fresh version instead`);
  }
  if (previous?.sourceSha === sha) return { version: previous.version, reason: 'already-published' };
  const floor = previous?.version ?? 'v0.0.0';
  const draft = versioned.find((release) =>
    release.draft && commitOf(release) === sha && compareVersions(release.tag_name, floor) > 0);
  if (draft) return { version: draft.tag_name, reason: 'resume-draft' };
  const match = VERSION.exec(floor);
  let patch = Number(match[3]) + 1;
  while (reserved.has(`v${match[1]}.${match[2]}.${patch}`)) patch += 1;
  return { version: `v${match[1]}.${match[2]}.${patch}`, reason: 'next' };
}

/** Drafts left behind by attempts this published release supersedes. */
export function staleDrafts(releases, publishedVersion) {
  return versionedReleases(releases).filter((release) =>
    release.draft && compareVersions(release.tag_name, publishedVersion) < 0);
}

/**
 * Where a phone rollback returns. The record is the newest published
 * release; `currentBranch` is what the production channel serves now.
 */
export function otaRollbackTarget({ record, currentBranch, explicitBranch = '' }) {
  if (explicitBranch) return { branch: explicitBranch, reason: 'explicit' };
  const ota = record?.components?.['mobile-ota'];
  if (!ota?.otaBranch) fail('the newest release record names no OTA branch; pass an explicit branch');
  if (!currentBranch) fail('cannot read the production channel');
  if (currentBranch === ota.otaBranch) {
    if (!ota.previousOtaBranch) fail(`${record.version} records no earlier OTA branch; pass an explicit branch`);
    return { branch: ota.previousOtaBranch, reason: `${record.version} is live; return to the release before it` };
  }
  if (currentBranch === ota.previousOtaBranch) {
    return { branch: currentBranch, reason: 'already rolled back', noop: true };
  }
  // A newer attempt promoted its own branch and then failed elsewhere: return
  // to the newest published release.
  return { branch: ota.otaBranch, reason: `${currentBranch} is not a published release; return to ${record.version}` };
}

const imageTag = (image) => String(image ?? '').replace(/@sha256:[0-9a-f]+$/, '');

/** Where a server rollback returns, from the Fly Machines' current images. */
export function serverRollbackImage({ record, machineImages, explicitImage = '' }) {
  if (explicitImage) {
    if (!explicitImage.startsWith('registry.fly.io/')) fail('server image must be a registry.fly.io ref');
    return { image: explicitImage, reason: 'explicit' };
  }
  const server = record?.components?.server;
  if (!server?.imageRef) fail('the newest release record names no server image; pass image_ref explicitly');
  const current = [...new Set(machineImages.map(imageTag))];
  if (current.length !== 1) return { image: server.imageRef, reason: `fleet is split (${current.join(', ')}); finish on ${record.version}` };
  if (current[0] === imageTag(server.imageRef)) {
    if (!server.previousImageRef) fail(`${record.version} records no earlier server image; pass image_ref explicitly`);
    return { image: server.previousImageRef, reason: `${record.version} is live; return to the image before it` };
  }
  if (current[0] === imageTag(server.previousImageRef)) return { image: current[0], reason: 'already rolled back', noop: true };
  return { image: server.imageRef, reason: `${current[0]} is not a published release; return to ${record.version}` };
}

function gh(args, { binary = false } = {}) {
  return execFileSync('gh', args, {
    encoding: binary ? 'buffer' : 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000,
  });
}

function listReleases(repository) {
  return JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repository}/releases?per_page=100`])).flat();
}

function downloadAsset(repository, release, name) {
  const asset = release.assets?.find((candidate) => candidate.name === name);
  if (!asset) return null;
  return gh(['api', '-H', 'Accept: application/octet-stream', `repos/${repository}/releases/assets/${asset.id}`], { binary: true });
}

function commitOfTag(repository, tag) {
  return gh(['api', `repos/${repository}/commits/${tag}`, '--jq', '.sha']).trim();
}

/** The newest published release's record, or a migration record for it. */
export function readPublishedRecord(repository, releases = listReleases(repository)) {
  const release = latestPublished(releases);
  if (!release) return null;
  const bytes = downloadAsset(repository, release, RELEASE_RECORD_ASSET);
  if (bytes) {
    const record = JSON.parse(bytes.toString('utf8'));
    if (record.version !== release.tag_name) fail(`${release.tag_name} carries a release.json for ${record.version}`);
    return record;
  }
  const manifest = downloadAsset(repository, release, 'Beeline-latest.json');
  return migrationRecord({
    version: release.tag_name,
    sourceSha: commitOfTag(repository, release.tag_name),
    desktopVersion: manifest ? JSON.parse(manifest.toString('utf8')).version : undefined,
  });
}

function options(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) parsed._.push(value);
    else parsed[value.slice(2)] = argv[++index] ?? '';
  }
  return parsed;
}

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function main(argv) {
  const args = options(argv);
  const repository = args.repository ?? process.env.GITHUB_REPOSITORY;
  const command = args._[0];
  if (command === 'identity') {
    // Reads every release once; writes the previous record and prints the
    // identity this dispatch uses.
    const releases = listReleases(repository).map((release) =>
      (!release.draft && release.tag_name === args.requested && VERSION.test(release.tag_name))
        ? { ...release, sourceSha: commitOfTag(repository, release.tag_name) } : release);
    const previous = readPublishedRecord(repository, releases);
    if (previous) write(args.previous, previous);
    const { version, reason } = assignReleaseVersion({ releases, previous, sha: args.sha, requestedVersion: args.requested ?? '' });
    const draft = versionedReleases(releases).find((release) => release.tag_name === version);
    console.error(`release identity ${version}@${args.sha}: ${reason}${previous ? ` (previous ${previous.version}${previous.migrated ? ', migrated' : ''})` : ''}`);
    process.stdout.write(`version=${version}\nreason=${reason}\nhas_release=${draft ? 'true' : 'false'}\n`);
    return;
  }
  if (command === 'previous') {
    const record = readPublishedRecord(repository);
    if (!record) fail('no published release exists');
    write(args.output, record);
    process.stdout.write(`version=${record.version}\n`);
    return;
  }
  if (command === 'for-run') {
    // The record a given release run published, if it published one.
    const runId = Number(args['run-id']);
    for (const release of publishedReleases(listReleases(repository)).slice(0, 10)) {
      const bytes = downloadAsset(repository, release, RELEASE_RECORD_ASSET);
      const record = bytes ? JSON.parse(bytes.toString('utf8')) : null;
      if (record?.runId === runId) {
        write(args.output, record);
        process.stdout.write(`version=${record.version}\n`);
        return;
      }
    }
    fail(`no published release record came from run ${runId}`);
  }
  if (command === 'stale-drafts') {
    for (const release of staleDrafts(listReleases(repository), args.version)) process.stdout.write(`${release.tag_name}\n`);
    return;
  }
  if (command === 'ota-rollback-target') {
    const record = JSON.parse(readFileSync(args.record, 'utf8'));
    const target = otaRollbackTarget({ record, currentBranch: args.current, explicitBranch: args.explicit ?? '' });
    process.stdout.write(`branch=${target.branch}\nnoop=${target.noop === true}\nreason=${target.reason}\n`);
    return;
  }
  if (command === 'server-rollback-image') {
    const record = args.record ? JSON.parse(readFileSync(args.record, 'utf8')) : null;
    const machines = JSON.parse(readFileSync(args.machines, 'utf8'));
    const target = serverRollbackImage({
      record, explicitImage: args.explicit ?? '',
      machineImages: machines.map((machine) => machine.imageRef ?? machine.config?.image),
    });
    process.stdout.write(`image=${target.image}\nnoop=${target.noop === true}\nreason=${target.reason}\n`);
    return;
  }
  fail('Usage: release-record.mjs <identity|previous|for-run|stale-drafts|ota-rollback-target|server-rollback-image>');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
