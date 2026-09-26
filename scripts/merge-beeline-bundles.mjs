#!/usr/bin/env node

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateBundleDirectory } from './pages-site.mjs';

export async function mergeBeelineBundles({ outputDir, inputDirs }) {
  outputDir = resolve(outputDir);
  inputDirs = inputDirs.map((directory) => resolve(directory));
  if (inputDirs.length === 0) throw new Error('at least one helper bundle directory is required');
  const inputs = [];
  for (const directory of inputDirs) {
    inputs.push({ directory, ...(await validateBundleDirectory(directory)) });
  }
  const identity = inputs[0].manifest;
  const bundles = {};
  await mkdir(outputDir, { recursive: true });
  for (const input of inputs) {
    if (
      input.manifest.sourceCommit !== identity.sourceCommit ||
      input.manifest.version !== identity.version
    ) {
      throw new Error(`helper bundle identity differs in ${input.directory}`);
    }
    for (const [platform, bundle] of Object.entries(input.manifest.bundles)) {
      if (bundles[platform]) throw new Error(`duplicate helper bundle platform ${platform}`);
      bundles[platform] = bundle;
      for (const name of [bundle.file, `${bundle.file}.sha256`]) {
        const source = join(input.directory, name);
        const destination = join(outputDir, name);
        if (source !== destination) await copyFile(source, destination);
      }
    }
  }
  const manifest = { ...identity, bundles };
  await writeFile(join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await validateBundleDirectory(outputDir, {
    expectedSha: identity.sourceCommit,
    expectedVersion: identity.version,
  });
  return manifest;
}

async function main() {
  const outputIndex = process.argv.indexOf('--output-dir');
  const outputDir = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
  const inputDirs = process.argv
    .flatMap((value, index) => (value === '--input-dir' ? [process.argv[index + 1]] : []))
    .filter(Boolean);
  if (!outputDir || inputDirs.length === 0) {
    throw new Error(
      'usage: merge-beeline-bundles.mjs --output-dir DIR --input-dir DIR [--input-dir DIR ...]',
    );
  }
  const manifest = await mergeBeelineBundles({ outputDir, inputDirs });
  console.log(
    `merge-beeline-bundles: ${Object.keys(manifest.bundles).sort().join(', ')} for ${manifest.version}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`merge-beeline-bundles: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
