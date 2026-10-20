import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('./.local/', import.meta.url));
const script = fileURLToPath(new URL('./join.mjs', import.meta.url));

test('joins SQL by proxy trace, excluding concurrent background and unrelated requests', async () => {
  await mkdir(directory, { recursive: true });
  const temp = await mkdtemp(join(directory, 'join-test-'));
  const moments = join(temp, 'moments.ndjson');
  const proxy = join(temp, 'proxy.ndjson');
  const sql = join(temp, 'sql.ndjson');
  const output = join(temp, 'samples.ndjson');
  try {
    const lines = (rows) => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
    await writeFile(moments, lines([{ kind: 'route', name: '/beeline/channels', variant: 'cold',
      clockDomain: 'device', clockSync: {
        before: { deviceMs: 90, hostBeforeMs: 474, hostAfterMs: 474 },
        after: { deviceMs: 250, hostBeforeMs: 634, hostAfterMs: 634 },
      }, startMs: 100, paintMs: 200, endMs: 250 }]));
    await writeFile(proxy, lines([
      { type: 'http', traceId: 'a', startMs: 494, endMs: 574 },
      { type: 'http', traceId: 'b', startMs: 474, endMs: 564 },
    ]));
    await writeFile(sql, lines([
      { type: 'sql', traceId: 'a', startMs: 504, endMs: 514 },
      { type: 'sql', traceId: 'b', startMs: 514, endMs: 524 },
      { type: 'sql', traceId: null, startMs: 524, endMs: 534 },
    ]));
    execFileSync(process.execPath, [script, '--moments', moments,
      '--proxy', proxy, '--sql', sql, '--out', output]);
    const sample = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(sample.startMs, 484);
    assert.equal(sample.paintMs, 584);
    assert.equal(sample.deviceStartMs, 100);
    assert.equal(sample.http.length, 1);
    assert.deepEqual(sample.sql.map((span) => span.traceId), ['a']);
    await writeFile(moments, lines([{ kind: 'route', name: 'room', variant: 'warm',
      clockDomain: 'device', startMs: 100, paintMs: 200, endMs: 250 }]));
    assert.throws(() => execFileSync(process.execPath, [script, '--moments', moments,
      '--proxy', proxy, '--out', output], { stdio: 'pipe' }), /calibration/);
  } finally {
    await rm(temp, { recursive: true });
  }
});
