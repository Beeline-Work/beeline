import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = join(dirname(fileURLToPath(import.meta.url)), 'clean-dist.mjs');

test('clean-dist removes dist without relying on platform shell tools', (t) => {
  const project = mkdtempSync(join(tmpdir(), 'beeline-clean-dist-'));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const output = join(project, 'dist', 'nested', 'output.js');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, 'built');

  const result = spawnSync(process.execPath, [script], {
    cwd: project,
    env: { ...process.env, PATH: '' },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(project, 'dist')), false);
});
