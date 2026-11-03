import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { manifestName, provenance } from './ci-build-provenance.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ci-provenance-'));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=CI fixture', '-c', 'user.email=ci@example.invalid', ...args], { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'Fixture');
  mkdirSync(join(root, 'packages/api-contract/dist'), { recursive: true });
  writeFileSync(join(root, 'packages/api-contract/dist/phone.js'), 'export const version = 1;\n');
  return { root, git, sha: git('rev-parse', 'HEAD') };
}

test('exact-head outputs verify, but missing, changed and extra compiled files fail closed', () => {
  const { root, sha } = fixture();
  try {
    const file = join(root, 'packages/api-contract/dist/phone.js');
    provenance('write', sha, root);
    provenance('verify', sha, root);
    writeFileSync(file, 'export const version = 2;\n');
    assert.throws(() => provenance('verify', sha, root), /outputs or provenance differ/);
    writeFileSync(file, 'export const version = 1;\n');
    const extra = join(root, 'packages/api-contract/dist/stale.js');
    writeFileSync(extra, 'export {};');
    assert.throws(() => provenance('verify', sha, root), /outputs or provenance differ/);
    rmSync(extra);
    rmSync(file);
    assert.throws(() => provenance('verify', sha, root), /No compiled workspace outputs/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('cross-commit task reuse cannot pass another head or runtime as a final artifact', () => {
  const { root, sha, git } = fixture();
  try {
    provenance('write', sha, root);
    git('commit', '-q', '--allow-empty', '-m', 'Next head');
    const next = git('rev-parse', 'HEAD');
    assert.throws(() => provenance('verify', sha, root), /checked-out commit/);
    assert.throws(() => provenance('verify', next, root), /outputs or provenance differ/);
    provenance('write', next, root);
    provenance('verify', next, root);
    const manifest = JSON.parse(readFileSync(join(root, manifestName), 'utf8'));
    manifest.nodeMajor = '0';
    writeFileSync(join(root, manifestName), JSON.stringify(manifest));
    assert.throws(() => provenance('verify', next, root), /outputs or provenance differ/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
