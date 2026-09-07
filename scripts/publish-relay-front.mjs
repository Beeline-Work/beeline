#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  diffAssociationDocuments,
  formatAssociationDiff,
  readLiveAssociations,
  validateRequiredAssociations,
} from './app-associations.mjs';

const DEFAULT_PRODUCTION_ROOT = '/home/lunchbox/buzz-router-relay-prod';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function readAssociationFiles(webRoot) {
  return {
    apple: JSON.parse(
      await readFile(join(webRoot, '.well-known', 'apple-app-site-association'), 'utf8'),
    ),
    android: JSON.parse(await readFile(join(webRoot, '.well-known', 'assetlinks.json'), 'utf8')),
  };
}

function assertNoAssociationRemoval(source, target) {
  const reports = [];
  for (const kind of ['apple', 'android']) {
    const diff = diffAssociationDocuments(kind, source[kind], target[kind]);
    if (diff.liveOnly.length > 0) {
      reports.push(formatAssociationDiff(kind, { repositoryOnly: [], liveOnly: diff.liveOnly }));
    }
  }
  if (reports.length > 0) {
    throw new Error(
      `Refusing to remove entries currently served by the target:\n\n${reports.join('\n\n')}\n\nReview the entries and rerun with --force only if their removal is intentional.`,
    );
  }
}

async function copyTreeAtomically(sourceRoot, targetRoot) {
  async function visit(relative = '') {
    const sourceDirectory = join(sourceRoot, relative);
    const targetDirectory = join(targetRoot, relative);
    await mkdir(targetDirectory, { recursive: true });
    for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
      const childRelative = join(relative, entry.name);
      if (entry.isDirectory()) {
        await visit(childRelative);
        continue;
      }
      if (!entry.isFile()) continue;
      const sourcePath = join(sourceRoot, childRelative);
      const targetPath = join(targetRoot, childRelative);
      const temporaryDirectory = await mkdtemp(join(targetDirectory, `.${entry.name}.publish-`));
      const temporaryPath = join(temporaryDirectory, entry.name);
      try {
        await copyFile(sourcePath, temporaryPath);
        await rename(temporaryPath, targetPath);
      } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    }
  }
  await visit();
}

async function reloadRelayFront(composeRoot) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(
      'docker',
      ['compose', '--project-directory', composeRoot, 'up', '-d', 'relay-front'],
      { stdio: 'inherit' },
    );
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`docker compose failed (${signal ?? `exit ${code}`})`));
    });
  });
}

export async function publishRelayFront({
  sourceRoot,
  targetRoot,
  composeRoot,
  force = false,
  reload = reloadRelayFront,
  currentlyServed,
}) {
  const source = await readAssociationFiles(sourceRoot);
  const requiredErrors = validateRequiredAssociations(source);
  if (requiredErrors.length > 0) throw new Error(requiredErrors.join('\n'));

  if (!force) {
    const live = currentlyServed ?? (await readLiveAssociations());
    assertNoAssociationRemoval(source, live);
    try {
      assertNoAssociationRemoval(source, await readAssociationFiles(targetRoot));
    } catch (error) {
      throw new Error(
        `Target safety check failed: ${error.message}\nRerun with --force only after reviewing both the live and on-host entries.`,
      );
    }
  }

  await copyTreeAtomically(sourceRoot, targetRoot);
  await reload(composeRoot);
}

async function main() {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const sourceRoot = resolve(option('--source-dir', join(repositoryRoot, 'relay-stack', 'web')));
  const productionRoot = resolve(option('--production-dir', DEFAULT_PRODUCTION_ROOT));
  const targetRoot = resolve(option('--target-dir', join(productionRoot, 'relay-front', 'web')));
  const force = process.argv.includes('--force');

  await stat(sourceRoot);
  await publishRelayFront({ sourceRoot, targetRoot, composeRoot: productionRoot, force });
  console.log(`Published ${sourceRoot} to ${targetRoot} and reloaded relay-front.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
