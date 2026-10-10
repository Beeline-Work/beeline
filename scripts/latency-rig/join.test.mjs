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
      startMs: 100, paintMs: 200, endMs: 250 }]));
    await writeFile(proxy, lines([
      { type: 'http', traceId: 'a', startMs: 110, endMs: 190 },
      { type: 'http', traceId: 'b', startMs: 90, endMs: 180 },
    ]));
    await writeFile(sql, lines([
      { type: 'sql', traceId: 'a', startMs: 120, endMs: 130 },
      { type: 'sql', traceId: 'b', startMs: 130, endMs: 140 },
      { type: 'sql', traceId: null, startMs: 140, endMs: 150 },
    ]));
    execFileSync(process.execPath, [script, '--moments', moments,
      '--proxy', proxy, '--sql', sql, '--out', output]);
    const sample = JSON.parse(await readFile(output, 'utf8'));
    assert.equal(sample.http.length, 1);
    assert.deepEqual(sample.sql.map((span) => span.traceId), ['a']);
  } finally {
    await rm(temp, { recursive: true });
  }
});
