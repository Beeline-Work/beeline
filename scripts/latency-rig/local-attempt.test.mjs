import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('failed local setup cannot reuse an old passing report at the same main SHA', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rig-local-attempt-'));
  try {
    await writeFile(join(dir, 'report.json'), JSON.stringify({ complete: true, commit: 'unchanged-main' }));
    const result = spawnSync('bash', [fileURLToPath(new URL('./local-attempt.sh', import.meta.url)), dir], {
      env: { ...process.env, LATENCY_RIG_DEVICE: 'not-a-disposable-emulator' }, encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    await assert.rejects(readFile(join(dir, 'report.json')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
