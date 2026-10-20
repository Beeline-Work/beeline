import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const script = fileURLToPath(new URL('./nightly-report.mjs', import.meta.url));
test('missing device capture still produces one alert report instead of a passing baseline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rig-nightly-'));
  try {
    await mkdir(join(dir, 'latency-rig-output'));
    const result = spawnSync(process.execPath, [script, 'missing.json', 'no-baseline.json'], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 1);
    const report = JSON.parse(await readFile(join(dir, 'latency-rig-output/nightly.json')));
    assert.equal(report.pass, false);
    assert.match(report.text, /Capture skipped/);
    await assert.rejects(readFile(join(dir, 'latency-rig-output/passing.json')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('unavailable PR range alerts rather than discarding the failed-night report', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rig-nightly-'));
  try {
    await mkdir(join(dir, 'latency-rig-output'));
    await writeFile(join(dir, 'baseline.json'), JSON.stringify({ commit: 'invalid' }));
    const result = spawnSync(process.execPath, [script, 'missing.json', 'baseline.json'], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 1);
    const report = JSON.parse(await readFile(join(dir, 'latency-rig-output/nightly.json')));
    assert.match(report.text, /PR range unavailable/);
    assert.equal(report.pass, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
