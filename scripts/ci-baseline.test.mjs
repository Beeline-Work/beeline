import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

test('CLI counts earlier attempts and rerun waiting when GitHub resets the run start', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-baseline-'));
  try {
    writeFileSync(join(dir, 'gh'), `#!/usr/bin/env node
const path = process.argv.at(-1);
const run = { id: 41308918718, run_attempt: 2, conclusion: 'success',
  run_started_at: '2026-11-01T13:31:13Z', updated_at: '2026-11-01T13:42:52Z' };
if (path.includes('workflows/')) console.log(JSON.stringify({ workflow_runs: [run] }));
else if (path.endsWith('/attempts/1')) console.log(JSON.stringify({ run_started_at: '2026-11-01T12:57:32Z' }));
else if (path.includes('/jobs?')) console.log(JSON.stringify([{ jobs: [] }]));
else process.exit(1);
`, { mode: 0o755 });
    const result = JSON.parse(execFileSync(process.execPath, [resolve('scripts/ci-baseline.mjs'), '1'], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8',
    }));
    assert.equal(result.runs[0].wallMinutes, 45.33);
    assert.equal(result.runs[0].startedAt, '2026-11-01T12:57:32Z');
    assert.equal(result.runs[0].completedAt, '2026-11-01T13:42:52Z');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
