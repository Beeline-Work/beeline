import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cases, checkProof } from './check-pr-proof.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

test('unrelated pull requests need no latency evidence', () => {
  assert.doesNotThrow(() => checkProof(['docs/agent-mobile.md'], ''));
});
test('sensitive changes require every case with numeric before and after values', () => {
  const files = ['apps/mobile/sources/push/notification-response.ts'];
  for (const body of ['', 'Rig before/after: pending', `Rig before/after: ${cases.slice(1).map(name => `${name}=10->9ms`).join('; ')}`])
    assert.throws(() => checkProof(files, body));
  assert.doesNotThrow(() => checkProof(files, `Rig before/after: ${cases.map(name => `${name}=100.5->90ms`).join('; ')}`));
});

test('the CI entry point fails a hot-path PR and passes after its body supplies all cases', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'beeline-latency-proof-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    git('init', '--quiet');
    git('-c', 'user.name=Rig test', '-c', 'user.email=rig@example.test', 'commit', '--allow-empty', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    mkdirSync(join(cwd, 'apps/mobile/sources/push'), { recursive: true });
    writeFileSync(join(cwd, 'apps/mobile/sources/push/example.ts'), 'export {};\n');
    git('add', '.');
    git('-c', 'user.name=Rig test', '-c', 'user.email=rig@example.test', 'commit', '-qm', 'change');
    const head = git('rev-parse', 'HEAD');
    const event = join(cwd, 'event.json');
    const run = body => {
      writeFileSync(event, JSON.stringify({ pull_request: { base: { sha: base }, head: { sha: head }, body } }));
      return spawnSync(process.execPath, [fileURLToPath(new URL('./check-pr-proof.mjs', import.meta.url))], {
        cwd, env: { ...process.env, GITHUB_EVENT_PATH: event }, encoding: 'utf8',
      });
    };
    assert.equal(run('No measurements yet.').status, 1);
    const passing = run(`Rig before/after: ${cases.map(name => `${name}=100->90ms`).join('; ')}`);
    assert.equal(passing.status, 0, passing.stderr);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
