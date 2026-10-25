import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { balanceFiles } from '../apps/server/scripts/ci-shards.mjs';

test('measured slow files land on separate shards with complete, disjoint coverage', () => {
  const times = { slow: 300, medium: 200, quick: 100, tiny: 10 };
  const shards = balanceFiles(Object.keys(times), times, 2);
  assert.deepEqual(shards.map((shard) => shard.milliseconds), [310, 300]);
  assert.deepEqual(shards.flatMap((shard) => shard.files).sort(), Object.keys(times).sort());
});

test('new tests remain covered, deleted timings are ignored, and discovery order does not change assignments', () => {
  const files = ['new.test.ts', 'old.test.ts', 'other.test.ts'];
  const timings = { 'old.test.ts': 100, 'other.test.ts': 300, 'deleted.test.ts': 200 };
  const first = balanceFiles(files, timings, 2);
  assert.deepEqual(balanceFiles([...files].reverse(), timings, 2), first);
  assert.ok(first.some((shard) => shard.files.includes('new.test.ts')));
  assert.equal(first.flatMap((shard) => shard.files).includes('deleted.test.ts'), false);
});

test('empty timing data falls back safely and duplicate discovery fails closed', () => {
  assert.equal(balanceFiles(['a', 'b'], {}, 2).flatMap((shard) => shard.files).length, 2);
  assert.throws(() => balanceFiles(['a', 'a'], {}, 2), /unique/);
  assert.throws(() => balanceFiles(['a'], {}, 0), /positive/);
});

test('isolated latency and voice suites remain covered exactly once outside parallel workers', () => {
  const shards = [1, 2, 3, 4].map(position => {
    const result = spawnSync(process.execPath, ['apps/server/scripts/run-ci-shard.mjs', `${position}/4`, '--list'], {
      encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  });
  assert.deepEqual(shards[2].isolatedFiles.sort(), ['src/production-corpus-width.test.ts', 'src/voice-room-runtime.test.ts']);
  const files = shards.flatMap(shard => [...shard.files, ...shard.isolatedFiles]);
  assert.equal(new Set(files).size, files.length);
  assert.equal(files.length, shards[0].totalFiles);
  for (const shard of shards) {
    for (const file of shards[2].isolatedFiles) assert.equal(shard.files.includes(file), false);
  }
});
