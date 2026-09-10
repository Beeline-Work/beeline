import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('the dead-code guard rejects a newly introduced unused export', () => {
  const result = spawnSync(
    process.execPath,
    [
      'scripts/check-dead-code.mjs',
      '--directory',
      'scripts/fixtures/dead-code-regression',
      '--baseline',
      'scripts/fixtures/dead-code-regression/baseline.json',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120_000,
    },
  );

  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /New dead-code findings \(1\)/);
  assert.match(result.stderr, /exports:src\/index\.ts:deliberatelyUnusedExport/);
});
