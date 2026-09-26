import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { writeBeelineArchive } from './beeline-archive.mjs';

test('carried payload and fresh build package to identical release bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'beeline-archive-'));
  try {
    const previous = join(root, 'previous');
    const carried = join(root, 'carried');
    const rebuilt = join(root, 'rebuilt');
    for (const dir of [previous, carried, rebuilt]) {
      mkdirSync(join(dir, 'bin'), { recursive: true });
      mkdirSync(join(dir, 'lib', 'beeline'), { recursive: true });
    }
    const identity = (commit, version) => JSON.stringify({ commit, version }) + '\n';
    writeFileSync(join(previous, 'bin', 'buzz-agent'), 'unchanged native bytes\n', { mode: 0o755 });
    writeFileSync(join(previous, 'lib', 'beeline', 'bundle.json'), identity('old', 'v1'));
    const oldArchive = join(root, 'old.tar.gz');
    await writeBeelineArchive(previous, oldArchive, root);
    execFileSync('tar', ['-C', carried, '-xzf', oldArchive]);
    writeFileSync(join(carried, 'lib', 'beeline', 'bundle.json'), identity('new', 'v2'));
    writeFileSync(join(rebuilt, 'bin', 'buzz-agent'), 'unchanged native bytes\n', { mode: 0o755 });
    writeFileSync(join(rebuilt, 'lib', 'beeline', 'bundle.json'), identity('new', 'v2'));
    const carriedArchive = join(root, 'carried.tar.gz');
    const rebuiltArchive = join(root, 'rebuilt.tar.gz');
    await writeBeelineArchive(carried, carriedArchive, root);
    await writeBeelineArchive(rebuilt, rebuiltArchive, root);
    assert.deepEqual(readFileSync(carriedArchive), readFileSync(rebuiltArchive));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
