import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
test('a skipped capture cannot upload a stale successful report from a previous night', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rig-capture-'));
  try {
    await mkdir(join(dir, 'latency-rig-output'));
    for (const name of ['report.json', 'report.md', 'samples.ndjson'])
      await writeFile(join(dir, 'latency-rig-output', name), 'stale previous pass');
    const result = spawnSync('bash', [fileURLToPath(new URL('./ci-timing.sh', import.meta.url))],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, LATENCY_RIG_CAPTURE_COMMAND: '' } });
    assert.equal(result.status, 2);
    for (const name of ['report.json', 'report.md', 'samples.ndjson'])
      await assert.rejects(readFile(join(dir, 'latency-rig-output', name)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
