#!/usr/bin/env node
//
// Publish verified per-platform CI artifacts to the host-local /dl store.
// The store is outside the checkout and is served directly by nginx at
// https://usebeeline.app/dl/. See docs/cli-bundle-channel.md.

import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

function fail(message) {
  throw new Error(message);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) fail(`${name} is required`);
  return value;
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function safeReleaseName(version, sourceCommit) {
  return `${version.replace(/[^0-9A-Za-z._-]/g, '_')}-${sourceCommit.slice(0, 12)}`;
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

async function readPublishedManifest(dlRoot) {
  try {
    return JSON.parse(await readFile(join(dlRoot, 'manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function publishedGenerationIsComplete(dlRoot, published) {
  const bundles = Object.values(published?.bundles ?? {});
  if (bundles.length === 0) return false;
  for (const bundle of bundles) {
    if (
      typeof bundle?.file !== 'string' ||
      !/^beeline-[a-z0-9-]+\.tar\.gz$/.test(bundle.file) ||
      typeof bundle.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(bundle.sha256)
    ) {
      return false;
    }
    try {
      const bytes = await readFile(join(dlRoot, bundle.file));
      const sidecar = await readFile(join(dlRoot, `${bundle.file}.sha256`), 'utf8');
      if (sha256(bytes) !== bundle.sha256 || sidecar.trim().split(/\s+/)[0] !== bundle.sha256) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

async function archivePublishedGeneration(dlRoot, published) {
  if (!published?.sourceCommit || !published?.version) return;
  const archiveRoot = join(dlRoot, '.versions');
  const archive = join(archiveRoot, safeReleaseName(published.version, published.sourceCommit));
  await mkdir(archive, { recursive: true });
  const files = new Set(['manifest.json']);
  for (const bundle of Object.values(published.bundles ?? {})) {
    if (typeof bundle?.file === 'string') {
      files.add(bundle.file);
      files.add(`${bundle.file}.sha256`);
    }
  }
  for (const file of files) {
    try {
      await copyFile(join(dlRoot, file), join(archive, basename(file)));
    } catch (error) {
      fail(`cannot archive current ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function pruneArchives(dlRoot, keep) {
  const archiveRoot = join(dlRoot, '.versions');
  let entries;
  try {
    entries = await readdir(archiveRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const directories = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(archiveRoot, entry.name);
    directories.push({ path, mtimeMs: (await stat(path)).mtimeMs });
  }
  directories.sort((a, b) => b.mtimeMs - a.mtimeMs);
  // `keep` includes the live generation. Archives hold the previous N-1.
  for (const entry of directories.slice(Math.max(0, keep - 1))) {
    await rm(entry.path, { recursive: true, force: true });
  }
}

async function main() {
  const commit = requireEnv('GITHUB_SHA');
  if (!/^[0-9a-f]{40}$/.test(commit)) fail(`GITHUB_SHA is not a full commit sha: ${commit}`);
  const rootDir = resolve(option('--dir', 'bundle'));
  const configuredOutput = option('--output-dir', process.env.BEELINE_DL_ROOT);
  if (!configuredOutput) {
    fail('--output-dir or BEELINE_DL_ROOT is required; refusing to publish into the checkout');
  }
  const dlRoot = resolve(configuredOutput);
  const keepText = option('--keep', process.env.BEELINE_DL_KEEP ?? '5');
  const keep = Number.parseInt(keepText, 10);
  if (!Number.isSafeInteger(keep) || keep < 1) fail(`--keep must be a positive integer: ${keepText}`);

  const platforms = await collectInputs(rootDir);
  for (const { platform, manifest, bundle } of platforms) {
    if (manifest.sourceCommit !== commit) {
      fail(`platform ${platform} was built from ${manifest.sourceCommit}, expected ${commit}`);
    }
    if (typeof manifest.version !== 'string' || !manifest.version) {
      fail(`platform ${platform} carries no version`);
    }
    if (bundle.verified !== true) {
      fail(`platform ${platform} was not verified on its host runner; refusing to publish an unverified bundle`);
    }
  }
  const versions = new Set(platforms.map(({ manifest }) => manifest.version));
  if (versions.size !== 1) fail(`platforms disagree on version: ${[...versions].join(', ')}`);

  await mkdir(dlRoot, { recursive: true });
  const published = await readPublishedManifest(dlRoot);
  const publishedComplete = await publishedGenerationIsComplete(dlRoot, published);
  if (published?.sourceCommit === commit && publishedComplete) {
    console.log(`publish-beeline-dl: manifest.json already publishes ${commit}; nothing to do`);
    return;
  }

  const staging = await mkdtemp(join(dlRoot, '.publish-'));
  try {
    const version = platforms[0].manifest.version;
    const bundles = {};
    for (const { platform, dir, bundle } of platforms) {
      const filename = `beeline-${platform}.tar.gz`;
      const tarball = await readFile(join(dir, bundle.file));
      const digest = sha256(tarball);
      if (digest !== bundle.sha256.toLowerCase()) {
        fail(`sha256 mismatch for ${platform}: manifest says ${bundle.sha256}, bytes hash ${digest}`);
      }
      if (typeof bundle.bytes === 'number' && tarball.byteLength !== bundle.bytes) {
        fail(`byte count mismatch for ${platform}: manifest says ${bundle.bytes}`);
      }
      await writeFile(join(staging, filename), tarball);
      await writeFile(join(staging, `${filename}.sha256`), `${digest}  ${filename}\n`);
      bundles[platform] = {
        file: filename,
        sha256: digest,
        ...(typeof bundle.bytes === 'number' ? { bytes: bundle.bytes } : {}),
        node: typeof bundle.node === 'string' ? bundle.node : '>=20.11.0',
        commit,
        version,
        verified: true,
      };
      console.log(`publish-beeline-dl: verified ${filename} (${tarball.byteLength} bytes, sha256 ${digest.slice(0, 12)}…)`);
    }
    const manifest = { schemaVersion: 1, sourceCommit: commit, version, bundles };
    await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    // Preserve the outgoing generation before replacing any public file.
    if (publishedComplete) await archivePublishedGeneration(dlRoot, published);

    // Every rename is same-filesystem and atomic. The manifest lands last, so
    // it can never advertise a file that has not already reached the store.
    for (const { platform } of platforms) {
      const filename = `beeline-${platform}.tar.gz`;
      await rename(join(staging, filename), join(dlRoot, filename));
      await rename(join(staging, `${filename}.sha256`), join(dlRoot, `${filename}.sha256`));
    }
    await rename(join(staging, 'manifest.json'), join(dlRoot, 'manifest.json'));
    await pruneArchives(dlRoot, keep);
    console.log(`publish-beeline-dl: published ${version} (${commit}); retaining ${keep} generations`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`publish-beeline-dl: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
