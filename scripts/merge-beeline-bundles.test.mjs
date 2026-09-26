import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { mergeBeelineBundles } from './merge-beeline-bundles.mjs';

const SHA = 'a'.repeat(40);

async function fixture(root, platform, version = 'v1.2.3') {
  const directory = join(root, platform);
  await mkdir(directory, { recursive: true });
  const file = `beeline-${platform}.tar.gz`;
  const bytes = Buffer.from(`bundle:${platform}`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(join(directory, file), bytes);
  await writeFile(join(directory, `${file}.sha256`), `${sha256}  ${file}\n`);
  await writeFile(
    join(directory, 'manifest.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      sourceCommit: SHA,
      version,
      bundles: {
        [platform]: {
          file,
          sha256,
          bytes: bytes.length,
          node: '>=20.11.0',
          commit: SHA,
          version,
          verified: true,
        },
      },
    })}\n`,
  );
  return directory;
}

test('merges verified native bundles into one release manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-bundle-merge-'));
  try {
    const inputs = await Promise.all(
      ['linux-x64', 'darwin-arm64', 'darwin-x64'].map((platform) => fixture(root, platform)),
    );
    const output = join(root, 'release');
    const manifest = await mergeBeelineBundles({ outputDir: output, inputDirs: inputs });
    assert.deepEqual(Object.keys(manifest.bundles).sort(), [
      'darwin-arm64',
      'darwin-x64',
      'linux-x64',
    ]);
    for (const bundle of Object.values(manifest.bundles)) {
      assert.deepEqual(await readFile(join(output, bundle.file)), Buffer.from(`bundle:${bundle.file.replace(/^beeline-|\.tar\.gz$/g, '')}`));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses to combine artifacts from different releases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beeline-bundle-merge-'));
  try {
    await assert.rejects(
      mergeBeelineBundles({
        outputDir: join(root, 'release'),
        inputDirs: [
          await fixture(root, 'linux-x64'),
          await fixture(root, 'darwin-arm64', 'v9.9.9'),
        ],
      }),
      /identity differs/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
