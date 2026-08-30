import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLISHER = path.join(REPO, 'scripts', 'publish-beeline-dl.mjs');

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function writeInput(root, { commit, version, bytes = Buffer.from(`bundle ${version}`) }) {
  const platform = 'linux-x64';
  const dir = path.join(root, platform);
  const file = `beeline-${platform}.tar.gz`;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), bytes);
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        sourceCommit: commit,
        version,
        bundles: {
          [platform]: {
            file,
            sha256: digest(bytes),
            bytes: bytes.length,
            node: '>=20.11.0',
            commit,
            version,
            verified: true,
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  return { file, bytes };
}

function publish(input, output, commit, keep = 5) {
  return spawnSync(
    process.execPath,
    [PUBLISHER, '--dir', input, '--output-dir', output, '--keep', String(keep)],
    { encoding: 'utf8', env: { ...process.env, GITHUB_SHA: commit } },
  );
}

test('publishes the unchanged manifest schema and retains the requested rollback generations', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beeline-publish-test.'));
  const output = path.join(tmp, 'host-dl');
  try {
    for (let generation = 1; generation <= 4; generation += 1) {
      const input = path.join(tmp, `input-${generation}`);
      const commit = String(generation).repeat(40);
      const version = `0.0.${generation}`;
      const { file, bytes } = writeInput(input, { commit, version });
      const result = publish(input, output, commit, 3);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'));
      assert.deepEqual(Object.keys(manifest), ['schemaVersion', 'sourceCommit', 'version', 'bundles']);
      assert.deepEqual(Object.keys(manifest.bundles['linux-x64']), [
        'file',
        'sha256',
        'bytes',
        'node',
        'commit',
        'version',
        'verified',
      ]);
      assert.equal(manifest.sourceCommit, commit);
      assert.deepEqual(fs.readFileSync(path.join(output, file)), bytes);
      assert.equal(manifest.bundles['linux-x64'].sha256, digest(bytes));
    }
    const archives = fs.readdirSync(path.join(output, '.versions'));
    assert.deepEqual(archives.sort(), ['0.0.2-222222222222', '0.0.3-333333333333']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('rejects corrupted input before changing the live manifest', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beeline-publish-test.'));
  const output = path.join(tmp, 'host-dl');
  try {
    const firstCommit = 'a'.repeat(40);
    const firstInput = path.join(tmp, 'first');
    writeInput(firstInput, { commit: firstCommit, version: '0.0.1' });
    assert.equal(publish(firstInput, output, firstCommit).status, 0);
    const before = fs.readFileSync(path.join(output, 'manifest.json'), 'utf8');

    const secondCommit = 'b'.repeat(40);
    const secondInput = path.join(tmp, 'second');
    const { file } = writeInput(secondInput, { commit: secondCommit, version: '0.0.2' });
    fs.appendFileSync(path.join(secondInput, 'linux-x64', file), 'corruption');
    const result = publish(secondInput, output, secondCommit);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /sha256 mismatch/);
    assert.equal(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'), before);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a same-commit rerun repairs an incomplete live generation', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beeline-publish-test.'));
  const output = path.join(tmp, 'host-dl');
  try {
    const commit = 'c'.repeat(40);
    const input = path.join(tmp, 'input');
    const { file, bytes } = writeInput(input, { commit, version: '0.0.3' });
    assert.equal(publish(input, output, commit).status, 0);
    fs.rmSync(path.join(output, file));

    const result = publish(input, output, commit);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(fs.readFileSync(path.join(output, file)), bytes);
    assert.match(result.stdout, /published 0\.0\.3/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('bundle workflow publishes to the host store without writing Git history', () => {
  const workflow = fs.readFileSync(path.join(REPO, '.github/workflows/beeline-bundle.yml'), 'utf8');
  assert.match(workflow, /BEELINE_DL_ROOT: \/home\/lunchbox\/buzz-router-relay-prod\/relay-front\/web\/dl/);
  assert.match(workflow, /contents: read/);
  assert.doesNotMatch(workflow, /git (?:add|commit|push)/);
  assert.doesNotMatch(workflow, /beeline-bundle-bot/);
});
