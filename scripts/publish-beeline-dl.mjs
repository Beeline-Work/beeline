#!/usr/bin/env node
//
// Assemble the per-platform build outputs produced by CI into the published
// bundle set at relay-stack/web/dl/ — the directory nginx serves at
// https://usebeeline.app/dl/ and apps/body/src/self-update-manifest.ts reads.
//
// Contract and safety properties live in docs/cli-bundle-channel.md:
//
// - Refuses to publish a platform that was not verified on its own native
//   runner (verified !== true in its partial manifest).
// - Refuses platforms whose partial manifests disagree on sourceCommit or
//   version, or whose tarball bytes do not match the recorded sha256.
// - Idempotent: when the already-published manifest.json names the current
//   sourceCommit, exits 0 without touching anything (workflow re-runs are
//   no-ops).
//
// Required environment:
//   GITHUB_SHA   full commit SHA the bundles were built from

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const dlRoot = resolve('relay-stack', 'web', 'dl');

function fail(message) {
  console.error(`publish-beeline-dl: ${message}`);
  process.exit(1);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) fail(`${name} is required`);
  return value;
}

const commit = requireEnv('GITHUB_SHA');
if (!/^[0-9a-f]{40}$/.test(commit)) fail(`GITHUB_SHA is not a full commit sha: ${commit}`);

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function collectInputs(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const platforms = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(rootDir, entry.name);
    let partial;
    try {
      partial = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    } catch {
      continue;
    }
    const bundleEntries = Object.entries(partial.bundles ?? {});
    if (bundleEntries.length !== 1) {
      fail(`partial manifest in ${entry.name} must carry exactly one platform bundle`);
    }
    const [platform, bundle] = bundleEntries[0];
    if (platform !== entry.name) {
      fail(`partial manifest in ${entry.name} declares platform ${platform}`);
    }
    platforms.push({ platform, dir, manifest: partial, bundle });
  }
  if (platforms.length === 0) fail(`no platform build outputs found under ${rootDir}`);
  return platforms;
}

async function main() {
  const rootIndex = process.argv.indexOf('--dir');
  const rootDir = rootIndex >= 0 ? resolve(process.argv[rootIndex + 1]) : resolve('bundle');
  const platforms = await collectInputs(rootDir);

  // Identity across all platforms must describe the same build, and every
  // platform must have been verified on its own native runner.
  for (const { platform, manifest, bundle } of platforms) {
    if (manifest.sourceCommit !== commit) {
      fail(`platform ${platform} was built from ${manifest.sourceCommit}, expected ${commit}`);
    }
    if (typeof manifest.version !== 'string' || !manifest.version) {
      fail(`platform ${platform} carries no version`);
    }
    if (bundle.verified !== true) {
      fail(
        `platform ${platform} was not verified on its host runner; refusing to publish an unverified bundle`,
      );
    }
  }
  for (const key of ['version']) {
    const values = new Set(platforms.map(({ manifest }) => manifest[key]));
    if (values.size !== 1) fail(`platforms disagree on ${key}: ${[...values].join(', ')}`);
  }

  await mkdir(dlRoot, { recursive: true });

  // Idempotency: an already-current published set means this run is a re-run
  // of the same commit — leave everything untouched.
  try {
    const published = JSON.parse(await readFile(join(dlRoot, 'manifest.json'), 'utf8'));
    if (published.sourceCommit === commit) {
      console.log(
        `publish-beeline-dl: relay-stack/web/dl/manifest.json already publishes ${commit}; nothing to do`,
      );
      return;
    }
  } catch {
    // No published manifest yet — proceed with first publish.
  }

  // Stable filenames: beeline-<platform>.tar.gz (+ .sha256). Copy bytes
  // verbatim and re-check each digest so a corrupted artifact fails here,
  // before anything lands in dl/.
  const version = platforms[0].manifest.version;
  const bundles = {};
  for (const { platform, dir, manifest, bundle } of platforms) {
    const filename = `beeline-${platform}.tar.gz`;
    const tarball = await readFile(join(dir, bundle.file));
    const digest = sha256(tarball);
    if (digest !== bundle.sha256.toLowerCase()) {
      fail(`sha256 mismatch for ${platform}: manifest says ${bundle.sha256}, bytes hash ${digest}`);
    }
    if (typeof bundle.bytes === 'number' && tarball.byteLength !== bundle.bytes) {
      fail(`byte count mismatch for ${platform}: manifest says ${bundle.bytes}`);
    }
    await copyFile(join(dir, bundle.file), join(dlRoot, filename));
    await writeFile(`${join(dlRoot, filename)}.sha256`, `${digest}  ${filename}\n`);
    bundles[platform] = {
      file: filename,
      sha256: digest,
      ...(typeof bundle.bytes === 'number' ? { bytes: bundle.bytes } : {}),
      node: typeof bundle.node === 'string' ? bundle.node : '>=20.11.0',
      commit,
      version,
      verified: true,
    };
    console.log(
      `publish-beeline-dl: staged ${filename} (${tarball.byteLength} bytes, sha256 ${digest.slice(0, 12)}…)`,
    );
  }

  // Manifest last, and only after every tarball of this set is in place.
  const manifestPath = join(dlRoot, 'manifest.json');
  await writeFile(
    manifestPath,
    `${JSON.stringify({ schemaVersion: 1, sourceCommit: commit, version, bundles }, null, 2)}\n`,
  );
  console.log(`publish-beeline-dl: wrote manifest.json for ${version} (${commit})`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
