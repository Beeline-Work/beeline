// Durable input for website-only deploys. All callers hold usebeeline-pages
// concurrency through download/publish/deploy; helpers consume Pages, not these
// mutable backup assets. A partial upload fails closed at byte validation.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateBundleDirectory } from './pages-site.mjs';

export const CHANNEL_TAG = 'helper-update-channel';

export async function downloadPagesChannel({ github, repo, directory }) {
  const { data: release } = await github.rest.repos.getReleaseByTag({ ...repo, tag: CHANNEL_TAG });
  async function download(name) {
    const asset = release.assets.find((entry) => entry.name === name);
    if (!asset)
      throw new Error(`durable helper channel is missing ${name}; run a release to repair it`);
    const { data } = await github.rest.repos.getReleaseAsset({
      ...repo,
      asset_id: asset.id,
      headers: { accept: 'application/octet-stream' },
    });
    return Buffer.from(data);
  }
  const manifestBytes = await download('manifest.json');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  await mkdir(directory, { recursive: true });
  for (const bundle of Object.values(manifest.bundles ?? {})) {
    if (!/^beeline-[a-z0-9-]+\.tar\.gz$/.test(bundle.file ?? '')) {
      throw new Error('durable helper channel has an unsafe filename');
    }
    for (const name of [bundle.file, `${bundle.file}.sha256`]) {
      await writeFile(join(directory, name), await download(name));
    }
  }
  await writeFile(join(directory, 'manifest.json'), manifestBytes);
  return (await validateBundleDirectory(directory)).manifest;
}

export async function publishPagesChannel({
  github,
  repo,
  directory,
  expectedSha,
  expectedVersion,
}) {
  const { manifest, files } = await validateBundleDirectory(directory, {
    expectedSha,
    expectedVersion,
  });
  let release;
  try {
    ({ data: release } = await github.rest.repos.getReleaseByTag({ ...repo, tag: CHANNEL_TAG }));
  } catch (error) {
    if (error.status !== 404) throw error;
    ({ data: release } = await github.rest.repos.createRelease({
      ...repo,
      tag_name: CHANNEL_TAG,
      target_commitish: manifest.sourceCommit,
      name: 'Current helper update channel',
      prerelease: true,
      make_latest: 'false',
      body: 'Rolling input for usebeeline.app/dl Pages deployments. Managed by the daemon release leg; do not edit assets by hand.',
    }));
  }
  // A retry replaces a partial backup too. Never update the manifest before
  // its payloads; an interrupted write cannot pass downloadPagesChannel.
  for (const name of [...files, 'manifest.json']) {
    const previous = release.assets.find((asset) => asset.name === name);
    if (previous) await github.rest.repos.deleteReleaseAsset({ ...repo, asset_id: previous.id });
    const data = await readFile(join(directory, name));
    await github.rest.repos.uploadReleaseAsset({
      ...repo,
      release_id: release.id,
      name,
      data,
      headers: { 'content-type': 'application/octet-stream', 'content-length': data.byteLength },
    });
  }
  return manifest;
}
