#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { validateRequiredAssociations } from './app-associations.mjs';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SOURCE_ROOT = join(REPOSITORY_ROOT, 'relay-stack', 'web');
const REQUIRED_STATIC_PATHS = [
  'index.html',
  'privacy/index.html',
  'terms/index.html',
  'brand/index.html',
  'review/index.html',
  'join/index.html',
  'join/invite.js',
  '404.html',
  'CNAME',
  '.nojekyll',
  '.well-known/apple-app-site-association',
  '.well-known/assetlinks.json',
];

function fail(message) {
  throw new Error(message);
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function requireRegularFile(path) {
  const details = await stat(path).catch(() => undefined);
  if (!details?.isFile()) fail(`required file is missing: ${path}`);
}

async function copyStaticTree(sourceRoot, outputRoot, current = sourceRoot) {
  await mkdir(outputRoot, { recursive: true });
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const sourcePath = join(current, entry.name);
    const sourceRelative = relative(sourceRoot, sourcePath);
    if (sourceRelative === 'dl' || sourceRelative.startsWith('dl/')) continue;
    const outputPath = join(outputRoot, sourceRelative);
    if (entry.isSymbolicLink()) fail(`Pages source may not contain symlinks: ${sourceRelative}`);
    if (entry.isDirectory()) {
      await mkdir(outputPath, { recursive: true });
      await copyStaticTree(sourceRoot, outputRoot, sourcePath);
    } else if (entry.isFile()) {
      await mkdir(dirname(outputPath), { recursive: true });
      await copyFile(sourcePath, outputPath);
    }
  }
}

async function readAssociations(root) {
  return {
    apple: JSON.parse(
      await readFile(join(root, '.well-known', 'apple-app-site-association'), 'utf8'),
    ),
    android: JSON.parse(await readFile(join(root, '.well-known', 'assetlinks.json'), 'utf8')),
  };
}

export async function validateBundleDirectory(bundleRoot, { expectedSha, expectedVersion } = {}) {
  const manifestPath = join(bundleRoot, 'manifest.json');
  const manifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest?.schemaVersion !== 1) fail('helper manifest must use schemaVersion 1');
  if (!/^[0-9a-f]{40}$/.test(manifest.sourceCommit ?? '')) {
    fail('helper manifest must name one full sourceCommit');
  }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    fail('helper manifest must name a version');
  }
  if (expectedSha && manifest.sourceCommit !== expectedSha)
    fail('helper sourceCommit differs from the release');
  if (expectedVersion && manifest.version !== expectedVersion)
    fail('helper version differs from the release');

  const bundles = Object.entries(manifest.bundles ?? {});
  if (bundles.length === 0) fail('helper manifest has no bundles');
  const files = [];
  for (const [platform, bundle] of bundles) {
    if (
      typeof bundle?.file !== 'string' ||
      !/^beeline-[a-z0-9-]+\.tar\.gz$/.test(bundle.file) ||
      basename(bundle.file) !== bundle.file
    ) {
      fail(`helper manifest names an unsafe ${platform} bundle file`);
    }
    if (bundle.verified !== true) fail(`helper manifest marks ${platform} as unverified`);
    if (bundle.commit !== manifest.sourceCommit || bundle.version !== manifest.version) {
      fail(`helper manifest ${platform} identity differs from its top-level identity`);
    }
    if (!/^[0-9a-f]{64}$/.test(bundle.sha256 ?? '')) {
      fail(`helper manifest has no usable ${platform} sha256`);
    }

    const archive = await readFile(join(bundleRoot, bundle.file));
    if (sha256(archive) !== bundle.sha256) fail(`${bundle.file} does not match its sha256`);
    if (typeof bundle.bytes === 'number' && bundle.bytes !== archive.byteLength) {
      fail(`${bundle.file} does not match its byte count`);
    }
    const sidecarName = `${bundle.file}.sha256`;
    const sidecar = await readFile(join(bundleRoot, sidecarName), 'utf8');
    if (sidecar.trim().split(/\s+/)[0] !== bundle.sha256) {
      fail(`${sidecarName} does not match the manifest sha256`);
    }
    files.push(bundle.file, sidecarName);
  }
  return { manifest, manifestBytes, files };
}

export async function buildPagesSite({
  sourceRoot = DEFAULT_SOURCE_ROOT,
  bundleRoot,
  outputRoot,
  expectedSha,
  expectedVersion,
}) {
  if (!bundleRoot) fail('bundleRoot is required');
  if (!outputRoot) fail('outputRoot is required');
  sourceRoot = resolve(sourceRoot);
  bundleRoot = resolve(bundleRoot);
  outputRoot = resolve(outputRoot);
  if (outputRoot === sourceRoot || outputRoot.startsWith(`${sourceRoot}/`)) {
    fail('Pages output must be outside relay-stack/web');
  }

  for (const path of REQUIRED_STATIC_PATHS) await requireRegularFile(join(sourceRoot, path));
  if ((await readFile(join(sourceRoot, 'CNAME'), 'utf8')).trim() !== 'usebeeline.app') {
    fail('CNAME must contain only usebeeline.app');
  }
  const associationErrors = validateRequiredAssociations(await readAssociations(sourceRoot));
  if (associationErrors.length > 0) fail(associationErrors.join('\n'));

  const bundle = await validateBundleDirectory(bundleRoot, { expectedSha, expectedVersion });
  await rm(outputRoot, { recursive: true, force: true });
  await copyStaticTree(sourceRoot, outputRoot);
  await copyFile(join(sourceRoot, 'install.sh'), join(outputRoot, 'install'));
  const outputDl = join(outputRoot, 'dl');
  await mkdir(outputDl, { recursive: true });
  for (const file of bundle.files) await copyFile(join(bundleRoot, file), join(outputDl, file));
  await writeFile(join(outputDl, 'manifest.json'), bundle.manifestBytes);

  for (const file of ['apple-app-site-association', 'assetlinks.json']) {
    const source = await readFile(join(sourceRoot, '.well-known', file));
    const output = await readFile(join(outputRoot, '.well-known', file));
    if (!source.equals(output)) fail(`Pages build changed .well-known/${file}`);
  }
  return bundle.manifest;
}

async function main() {
  if (process.argv[2] !== 'build') {
    fail('usage: pages-site.mjs build --bundle-dir <path> --output-dir <path>');
  }
  const manifest = await buildPagesSite({
    bundleRoot: option('--bundle-dir'),
    outputRoot: option('--output-dir'),
    expectedSha: option('--sha'),
    expectedVersion: option('--version'),
  });
  console.log(
    `pages-site: built usebeeline.app for ${manifest.version} (${manifest.sourceCommit})`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`pages-site: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
